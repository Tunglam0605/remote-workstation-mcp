import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { PolicyEngine } from '../../policy.js';
import { PathGuard } from '../../security/path-guard.js';
import { ArtifactIntegrityAdapter, type AcceptedArtifact, type ArtifactManifestV1 } from './artifact-integrity.js';

const MAX_ARTIFACT_BYTES = 128 * 1024 * 1024;
const DEFAULT_TTL_MS = 2 * 60 * 1000;
const MAX_TTL_MS = 10 * 60 * 1000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const ALLOWED_EXTENSIONS = new Set(['.elf', '.axf', '.hex', '.bin']);

export interface ArtifactTransferOffer {
  schemaVersion: 1;
  transferId: string;
  endpoint: string;
  ticket: string;
  artifactName: string;
  expectedSha256: string;
  expectedSize: number;
  expiresAt: string;
  transport: 'tailscale-http';
}

export interface ArtifactTransferReceipt {
  schemaVersion: 1;
  transferId: string;
  transport: 'tailscale-http';
  source: ArtifactManifestV1;
  accepted: AcceptedArtifact;
}

interface TransferOptions {
  bindAddress?: string;
  allowLoopbackForTests?: boolean;
  now?: () => number;
}

interface ActiveOffer {
  server: http.Server;
  timer: NodeJS.Timeout;
  transferId: string;
  ticketHash: Buffer;
  workspace: string;
  projectPath: string;
  artifactName: string;
  expectedSha256: string;
  expectedSize: number;
  incomingRelative: string;
  expiresAtMs: number;
  receiving: boolean;
  consumed: boolean;
}

function normalizeSha256(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error('expectedSha256 must be exactly 64 hexadecimal characters.');
  }
  return normalized;
}

function validateExpectedSize(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_ARTIFACT_BYTES) {
    throw new Error(`expectedSize must be an integer between 1 and ${MAX_ARTIFACT_BYTES}.`);
  }
  return value;
}

function validateArtifactName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 180 || path.basename(trimmed) !== trimmed || trimmed === '.' || trimmed === '..') {
    throw new Error('artifactName must be a plain filename of at most 180 characters.');
  }
  const ext = path.extname(trimmed).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) throw new Error('artifactName must end in .elf, .axf, .hex or .bin.');
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) {
    throw new Error('artifactName may contain only letters, numbers, dot, underscore and dash.');
  }
  return trimmed;
}

function isTailscaleIpv4(address: string): boolean {
  const parts = address.split('.').map(item => Number(item));
  return parts.length === 4 &&
    parts.every(item => Number.isInteger(item) && item >= 0 && item <= 255) &&
    parts[0] === 100 &&
    parts[1]! >= 64 &&
    parts[1]! <= 127;
}

function isLoopbackIpv4(address: string): boolean {
  return /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(address);
}

function localIpv4Addresses(): string[] {
  const result: string[] = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) result.push(entry.address);
    }
  }
  return [...new Set(result)];
}

function chooseBindAddress(options: TransferOptions): string {
  if (options.bindAddress) {
    if (options.allowLoopbackForTests && isLoopbackIpv4(options.bindAddress)) return options.bindAddress;
    const locals = localIpv4Addresses();
    if (!locals.includes(options.bindAddress)) throw new Error('Configured artifact transfer bind address is not a local IPv4 interface.');
    if (!isTailscaleIpv4(options.bindAddress)) {
      throw new Error('Artifact transfer bind address must be a Tailscale IPv4 address (100.64.0.0/10).');
    }
    return options.bindAddress;
  }
  const candidate = localIpv4Addresses().find(isTailscaleIpv4);
  if (!candidate) throw new Error('No local Tailscale IPv4 address is available for native artifact transfer.');
  return candidate;
}

function validatePeerEndpoint(raw: string, allowLoopbackForTests = false): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    throw new Error('transferEndpoint must be a valid URL.');
  }
  if (endpoint.protocol !== 'http:') throw new Error('Native artifact transfer currently requires http over the encrypted Tailscale transport.');
  if (endpoint.username || endpoint.password || endpoint.hash || endpoint.search) {
    throw new Error('transferEndpoint must not include credentials, query parameters or fragments.');
  }
  const host = endpoint.hostname;
  if (!(isTailscaleIpv4(host) || (allowLoopbackForTests && isLoopbackIpv4(host)))) {
    throw new Error('transferEndpoint host must be a Tailscale IPv4 address.');
  }
  if (!/^\/artifact-transfer\/[A-Za-z0-9._-]{8,128}$/.test(endpoint.pathname)) {
    throw new Error('transferEndpoint path is not a valid RWMCP artifact transfer endpoint.');
  }
  return endpoint;
}

function hashTicket(ticket: string): Buffer {
  return createHash('sha256').update(ticket, 'utf8').digest();
}

function ticketMatches(expected: Buffer, ticket: string): boolean {
  const actual = hashTicket(ticket);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function portable(value: string): string {
  return value.split(path.sep).join('/');
}

async function readBoundedResponse(response: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += data.length;
    if (size > MAX_RESPONSE_BYTES) throw new Error('Artifact transfer response exceeded the bounded response limit.');
    chunks.push(data);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export class ArtifactTransferAdapter {
  private readonly active = new Map<string, ActiveOffer>();
  private readonly now: () => number;

  constructor(
    private readonly policy: PolicyEngine,
    private readonly paths: PathGuard,
    private readonly integrity: ArtifactIntegrityAdapter,
    private readonly options: TransferOptions = {}
  ) {
    this.now = options.now ?? (() => Date.now());
  }

  private async closeOffer(offer: ActiveOffer): Promise<void> {
    clearTimeout(offer.timer);
    this.active.delete(offer.transferId);
    if (offer.server.listening) {
      await new Promise<void>(resolve => offer.server.close(() => resolve()));
    }
  }

  async createReceiveOffer(options: {
    workspace: string;
    projectPath: string;
    artifactName: string;
    expectedSha256: string;
    expectedSize: number;
    ttlMs?: number;
  }): Promise<ArtifactTransferOffer> {
    this.policy.assertEngineeringExecute();
    this.policy.assertWrite(options.workspace);
    const artifactName = validateArtifactName(options.artifactName);
    const expectedSha256 = normalizeSha256(options.expectedSha256);
    const expectedSize = validateExpectedSize(options.expectedSize);
    const ttlMs = Math.min(Math.max(options.ttlMs ?? DEFAULT_TTL_MS, 10_000), MAX_TTL_MS);
    const bindAddress = chooseBindAddress(this.options);
    const projectRoot = await this.paths.resolveExisting(options.workspace, options.projectPath);
    const incomingDir = path.join(projectRoot, '.rwmcp', 'artifacts', 'incoming');
    await fs.mkdir(incomingDir, { recursive: true });

    const transferId = randomUUID();
    const ticket = randomBytes(32).toString('base64url');
    const ticketHash = hashTicket(ticket);
    const incomingRelative = portable(path.join('.rwmcp', 'artifacts', 'incoming', `${transferId}-${artifactName}`));
    const incomingAbsolute = path.join(projectRoot, ...incomingRelative.split('/'));
    const tempAbsolute = `${incomingAbsolute}.part`;
    const expiresAtMs = this.now() + ttlMs;

    let offer!: ActiveOffer;
    const server = http.createServer((request, response) => {
      void (async () => {
        const fail = async (status: number, message: string) => {
          response.statusCode = status;
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({ ok: false, error: message }));
        };

        if (offer.consumed) return fail(410, 'Transfer ticket has already been consumed.');
        if (this.now() >= offer.expiresAtMs) return fail(410, 'Transfer ticket has expired.');
        if (request.method !== 'PUT' || request.url !== `/artifact-transfer/${offer.transferId}`) {
          return fail(404, 'Transfer endpoint not found.');
        }
        if (offer.receiving) return fail(409, 'Transfer is already in progress.');

        const auth = request.headers.authorization ?? '';
        const ticketValue = auth.startsWith('Bearer ') ? auth.slice(7) : '';
        if (!ticketValue || !ticketMatches(offer.ticketHash, ticketValue)) return fail(401, 'Invalid transfer ticket.');

        const contentLengthRaw = request.headers['content-length'];
        const contentLength = typeof contentLengthRaw === 'string' ? Number(contentLengthRaw) : NaN;
        if (!Number.isSafeInteger(contentLength) || contentLength !== offer.expectedSize) {
          return fail(400, `Content-Length must equal expected artifact size ${offer.expectedSize}.`);
        }
        const declaredSha = typeof request.headers['x-rwmcp-sha256'] === 'string'
          ? request.headers['x-rwmcp-sha256'].trim().toLowerCase()
          : '';
        if (declaredSha !== offer.expectedSha256) return fail(400, 'Declared SHA-256 does not match the receive offer.');

        offer.receiving = true;
        const hash = createHash('sha256');
        let received = 0;
        const meter = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            received += chunk.length;
            if (received > offer.expectedSize || received > MAX_ARTIFACT_BYTES) {
              callback(new Error('Incoming artifact exceeded the declared size.'));
              return;
            }
            hash.update(chunk);
            callback(null, chunk);
          }
        });

        try {
          await fs.unlink(tempAbsolute).catch(() => undefined);
          await pipeline(request, meter, createWriteStream(tempAbsolute, { flags: 'wx', mode: 0o600 }));
          const actualSha = hash.digest('hex');
          if (received !== offer.expectedSize) throw new Error(`Received ${received} bytes; expected ${offer.expectedSize}.`);
          if (actualSha !== offer.expectedSha256) {
            throw new Error(`Received SHA-256 ${actualSha}; expected ${offer.expectedSha256}.`);
          }
          await fs.rename(tempAbsolute, incomingAbsolute);
          const accepted = await this.integrity.accept({
            workspace: offer.workspace,
            projectPath: offer.projectPath,
            artifact: offer.incomingRelative,
            expectedSha256: offer.expectedSha256,
            expectedSize: offer.expectedSize
          });
          await fs.unlink(incomingAbsolute).catch(() => undefined);
          offer.consumed = true;
          response.statusCode = 200;
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({
            ok: true,
            schemaVersion: 1,
            transferId: offer.transferId,
            accepted
          }));
          setImmediate(() => { void this.closeOffer(offer); });
        } catch (error) {
          await fs.unlink(tempAbsolute).catch(() => undefined);
          await fs.unlink(incomingAbsolute).catch(() => undefined);
          offer.receiving = false;
          await fail(400, error instanceof Error ? error.message : String(error));
        }
      })().catch(async error => {
        response.statusCode = 500;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      });
    });

    offer = {
      server,
      timer: setTimeout(() => {
        void (async () => {
          await fs.unlink(tempAbsolute).catch(() => undefined);
          await fs.unlink(incomingAbsolute).catch(() => undefined);
          await this.closeOffer(offer);
        })();
      }, ttlMs),
      transferId,
      ticketHash,
      workspace: options.workspace,
      projectPath: options.projectPath,
      artifactName,
      expectedSha256,
      expectedSize,
      incomingRelative,
      expiresAtMs,
      receiving: false,
      consumed: false
    };
    offer.timer.unref();

    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, bindAddress, () => {
          server.off('error', reject);
          resolve();
        });
      });
    } catch (error) {
      clearTimeout(offer.timer);
      throw error;
    }

    this.active.set(transferId, offer);
    const address = server.address();
    if (!address || typeof address === 'string') {
      await this.closeOffer(offer);
      throw new Error('Unable to determine native artifact transfer listener address.');
    }

    return {
      schemaVersion: 1,
      transferId,
      endpoint: `http://${bindAddress}:${address.port}/artifact-transfer/${transferId}`,
      ticket,
      artifactName,
      expectedSha256,
      expectedSize,
      expiresAt: new Date(expiresAtMs).toISOString(),
      transport: 'tailscale-http'
    };
  }

  async push(options: {
    workspace: string;
    projectPath: string;
    artifact: string;
    endpoint: string;
    ticket: string;
    expectedSha256: string;
    expectedSize: number;
    timeoutMs?: number;
  }): Promise<ArtifactTransferReceipt> {
    this.policy.assertEngineeringExecute();
    const expectedSha256 = normalizeSha256(options.expectedSha256);
    const expectedSize = validateExpectedSize(options.expectedSize);
    const endpoint = validatePeerEndpoint(options.endpoint, this.options.allowLoopbackForTests ?? false);
    if (!/^[-_A-Za-z0-9]{32,256}$/.test(options.ticket)) throw new Error('transferTicket has an invalid format.');

    const manifest = await this.integrity.prepare(options.workspace, options.projectPath, options.artifact);
    if (manifest.sha256 !== expectedSha256) {
      throw new Error(`Source artifact SHA-256 mismatch: expected ${expectedSha256}, got ${manifest.sha256}.`);
    }
    if (manifest.size !== expectedSize) {
      throw new Error(`Source artifact size mismatch: expected ${expectedSize}, got ${manifest.size}.`);
    }
    const absolute = await this.paths.resolveExisting(options.workspace, path.join(options.projectPath, manifest.artifact));
    const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 120_000, 5_000), 10 * 60 * 1000);

    const response = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
      const request = http.request(endpoint, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${options.ticket}`,
          'content-type': 'application/octet-stream',
          'content-length': String(manifest.size),
          'x-rwmcp-sha256': manifest.sha256,
          'x-rwmcp-transfer-version': '1'
        }
      }, async incoming => {
        try {
          resolve({ statusCode: incoming.statusCode ?? 0, body: await readBoundedResponse(incoming) });
        } catch (error) {
          reject(error);
        }
      });
      request.setTimeout(timeoutMs, () => request.destroy(new Error('Artifact transfer timed out.')));
      request.once('error', reject);
      createReadStream(absolute).once('error', reject).pipe(request);
    });

    let parsed: unknown;
    try {
      parsed = JSON.parse(response.body);
    } catch {
      throw new Error(`Artifact receiver returned non-JSON response (HTTP ${response.statusCode}).`);
    }
    if (response.statusCode !== 200) {
      const message = parsed && typeof parsed === 'object' && 'error' in parsed ? String((parsed as { error: unknown }).error) : response.body;
      throw new Error(`Artifact receiver rejected transfer (HTTP ${response.statusCode}): ${message}`);
    }
    const record = parsed as { transferId?: unknown; accepted?: AcceptedArtifact };
    if (typeof record.transferId !== 'string' || !record.accepted) {
      throw new Error('Artifact receiver response is missing transfer receipt fields.');
    }
    if (record.accepted.sha256 !== manifest.sha256 || record.accepted.size !== manifest.size) {
      throw new Error('Artifact receiver receipt does not match the source manifest.');
    }

    return {
      schemaVersion: 1,
      transferId: record.transferId,
      transport: 'tailscale-http',
      source: manifest,
      accepted: record.accepted
    };
  }

  async closeAllForTests(): Promise<void> {
    await Promise.all([...this.active.values()].map(offer => this.closeOffer(offer)));
  }
}
