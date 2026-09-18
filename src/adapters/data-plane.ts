import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { PolicyEngine } from '../policy.js';
import { PathGuard } from '../security/path-guard.js';

const MAX_TRANSFER_BYTES = 512 * 1024 * 1024;
const DEFAULT_TTL_MS = 2 * 60 * 1000;
const MAX_TTL_MS = 10 * 60 * 1000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const HISTORY_LIMIT = 32;

export interface DataPlaneManifestV1 {
  schemaVersion: 1;
  file: string;
  sha256: string;
  size: number;
}

export interface DataPlaneAcceptedFile extends DataPlaneManifestV1 {
  verifiedPath: string;
  manifestPath: string;
  reused: boolean;
}

export interface DataPlaneOffer {
  schemaVersion: 1;
  transferId: string;
  endpoint: string;
  ticket: string;
  fileName: string;
  expectedSha256: string;
  expectedSize: number;
  expiresAt: string;
  transport: 'tailscale-http';
}

export interface DataPlaneReceipt {
  schemaVersion: 1;
  transferId: string;
  transport: 'tailscale-http';
  source: DataPlaneManifestV1;
  accepted: DataPlaneAcceptedFile;
}

export interface DataPlaneStatus {
  transport: 'tailscale-http';
  maxTransferBytes: number;
  tailscaleIpv4Available: boolean;
  activeOffers: Array<{
    transferId: string;
    fileName: string;
    expectedSha256: string;
    expectedSize: number;
    expiresAt: string;
    state: 'waiting' | 'receiving';
  }>;
  recentTransfers: Array<{
    transferId: string;
    direction: 'send' | 'receive';
    fileName: string;
    sha256: string;
    size: number;
    status: 'succeeded' | 'failed';
    completedAt: string;
    error?: string;
  }>;
}

interface DataPlaneOptions {
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
  basePath: string;
  fileName: string;
  expectedSha256: string;
  expectedSize: number;
  incomingRelative: string;
  expiresAtMs: number;
  receiving: boolean;
  consumed: boolean;
  request?: http.IncomingMessage;
}

type HistoryEntry = DataPlaneStatus['recentTransfers'][number];

function assertRelativeFile(value: string): string {
  if (!value || value.length > 1024) throw new Error('file path must contain 1..1024 characters.');
  if (path.isAbsolute(value)) throw new Error('file path must be relative to the selected base path.');
  const segments = value.split(/[\\/]+/);
  if (segments.includes('..')) throw new Error('file path must not escape the selected base path.');
  return path.normalize(value);
}

function validateFileName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 180 || path.basename(trimmed) !== trimmed || trimmed === '.' || trimmed === '..') {
    throw new Error('fileName must be a plain filename of at most 180 characters.');
  }
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) {
    throw new Error('fileName may contain only letters, numbers, dot, underscore and dash.');
  }
  return trimmed;
}

function normalizeSha256(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error('expectedSha256 must be exactly 64 hexadecimal characters.');
  }
  return normalized;
}

function validateSize(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TRANSFER_BYTES) {
    throw new Error(`expectedSize must be an integer between 1 and ${MAX_TRANSFER_BYTES}.`);
  }
  return value;
}

function portable(value: string): string {
  return value.split(path.sep).join('/');
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

function chooseBindAddress(options: DataPlaneOptions): string {
  if (options.bindAddress) {
    if (options.allowLoopbackForTests && isLoopbackIpv4(options.bindAddress)) return options.bindAddress;
    const locals = localIpv4Addresses();
    if (!locals.includes(options.bindAddress)) throw new Error('Configured data-plane bind address is not a local IPv4 interface.');
    if (!isTailscaleIpv4(options.bindAddress)) {
      throw new Error('Data-plane bind address must be a Tailscale IPv4 address (100.64.0.0/10).');
    }
    return options.bindAddress;
  }
  const candidate = localIpv4Addresses().find(isTailscaleIpv4);
  if (!candidate) throw new Error('No local Tailscale IPv4 address is available for the native data plane.');
  return candidate;
}

function validatePeerEndpoint(raw: string, allowLoopbackForTests = false): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    throw new Error('transferEndpoint must be a valid URL.');
  }
  if (endpoint.protocol !== 'http:') {
    throw new Error('Native data-plane transfer requires http over the encrypted Tailscale transport.');
  }
  if (endpoint.username || endpoint.password || endpoint.hash || endpoint.search) {
    throw new Error('transferEndpoint must not include credentials, query parameters or fragments.');
  }
  const host = endpoint.hostname;
  if (!(isTailscaleIpv4(host) || (allowLoopbackForTests && isLoopbackIpv4(host)))) {
    throw new Error('transferEndpoint host must be a Tailscale IPv4 address.');
  }
  if (!/^\/rwmcp-data\/[-A-Za-z0-9._]{8,128}$/.test(endpoint.pathname)) {
    throw new Error('transferEndpoint path is not a valid RWMCP data-plane endpoint.');
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

async function hashFile(file: string): Promise<{ sha256: string; size: number }> {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(file)) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += data.length;
    if (size > MAX_TRANSFER_BYTES) throw new Error(`file exceeds the ${MAX_TRANSFER_BYTES} byte data-plane limit.`);
    hash.update(data);
  }
  return { sha256: hash.digest('hex'), size };
}

async function copyAndHash(source: string, target: string): Promise<{ sha256: string; size: number }> {
  const hash = createHash('sha256');
  let size = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > MAX_TRANSFER_BYTES) {
        callback(new Error(`file exceeds the ${MAX_TRANSFER_BYTES} byte data-plane limit.`));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    }
  });
  await pipeline(createReadStream(source), meter, createWriteStream(target, { flags: 'wx', mode: 0o600 }));
  return { sha256: hash.digest('hex'), size };
}

async function readBoundedResponse(response: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += data.length;
    if (size > MAX_RESPONSE_BYTES) throw new Error('Data-plane response exceeded the bounded response limit.');
    chunks.push(data);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export class DataPlaneAdapter {
  private readonly active = new Map<string, ActiveOffer>();
  private readonly history: HistoryEntry[] = [];
  private readonly now: () => number;

  constructor(
    private readonly policy: PolicyEngine,
    private readonly paths: PathGuard,
    private readonly options: DataPlaneOptions = {}
  ) {
    this.now = options.now ?? (() => Date.now());
  }

  private assertOperational(): void {
    if (this.policy.effectiveMode() === 'read_only') {
      throw new Error('Native data-plane transfer is disabled in read_only mode.');
    }
  }

  private record(entry: HistoryEntry): void {
    this.history.unshift(entry);
    if (this.history.length > HISTORY_LIMIT) this.history.length = HISTORY_LIMIT;
  }

  private async closeOffer(offer: ActiveOffer): Promise<void> {
    clearTimeout(offer.timer);
    this.active.delete(offer.transferId);
    if (offer.server.listening) {
      await new Promise<void>(resolve => offer.server.close(() => resolve()));
    }
  }

  status(): DataPlaneStatus {
    return {
      transport: 'tailscale-http',
      maxTransferBytes: MAX_TRANSFER_BYTES,
      tailscaleIpv4Available: localIpv4Addresses().some(isTailscaleIpv4) || Boolean(this.options.allowLoopbackForTests),
      activeOffers: [...this.active.values()].map(offer => ({
        transferId: offer.transferId,
        fileName: offer.fileName,
        expectedSha256: offer.expectedSha256,
        expectedSize: offer.expectedSize,
        expiresAt: new Date(offer.expiresAtMs).toISOString(),
        state: offer.receiving ? 'receiving' : 'waiting'
      })),
      recentTransfers: [...this.history]
    };
  }

  async prepare(workspace: string, basePath: string, file: string): Promise<DataPlaneManifestV1> {
    const relative = assertRelativeFile(file);
    const absolute = await this.paths.resolveExisting(workspace, path.join(basePath, relative));
    const stat = await fs.stat(absolute);
    if (!stat.isFile()) throw new Error('file must resolve to a regular file.');
    if (stat.size <= 0) throw new Error('file is empty.');
    if (stat.size > MAX_TRANSFER_BYTES) throw new Error(`file exceeds the ${MAX_TRANSFER_BYTES} byte data-plane limit.`);
    const digest = await hashFile(absolute);
    return {
      schemaVersion: 1,
      file: portable(relative),
      sha256: digest.sha256,
      size: digest.size
    };
  }

  async accept(options: {
    workspace: string;
    basePath: string;
    file: string;
    expectedSha256: string;
    expectedSize: number;
  }): Promise<DataPlaneAcceptedFile> {
    this.policy.assertWrite(options.workspace);
    const relative = assertRelativeFile(options.file);
    const expectedSha256 = normalizeSha256(options.expectedSha256);
    const expectedSize = validateSize(options.expectedSize);
    const baseRoot = await this.paths.resolveExisting(options.workspace, options.basePath);
    const source = await this.paths.resolveExisting(options.workspace, path.join(options.basePath, relative));
    const sourceStat = await fs.stat(source);
    if (!sourceStat.isFile()) throw new Error('file must resolve to a regular file.');

    const verifiedDir = path.join(baseRoot, '.rwmcp', 'transfers', 'verified');
    await fs.mkdir(verifiedDir, { recursive: true });
    const basename = path.basename(relative);
    const finalAbsolute = path.join(verifiedDir, `${expectedSha256}-${basename}`);
    const manifestAbsolute = `${finalAbsolute}.manifest.json`;
    const tempAbsolute = path.join(verifiedDir, `.${randomUUID()}.tmp`);

    try {
      const copied = await copyAndHash(source, tempAbsolute);
      if (copied.sha256 !== expectedSha256) {
        throw new Error(`file SHA-256 mismatch: expected ${expectedSha256}, got ${copied.sha256}.`);
      }
      if (copied.size !== expectedSize) {
        throw new Error(`file size mismatch: expected ${expectedSize}, got ${copied.size}.`);
      }

      let reused = false;
      try {
        const existing = await hashFile(finalAbsolute);
        if (existing.sha256 !== copied.sha256 || existing.size !== copied.size) {
          throw new Error('verified transfer destination already exists with different content.');
        }
        reused = true;
        await fs.unlink(tempAbsolute);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          await fs.rename(tempAbsolute, finalAbsolute);
        } else if (error instanceof Error && error.message === 'verified transfer destination already exists with different content.') {
          throw error;
        } else if (!reused) {
          throw error;
        }
      }

      const verifiedPath = portable(path.relative(baseRoot, finalAbsolute));
      const manifestPath = portable(path.relative(baseRoot, manifestAbsolute));
      const manifest = {
        schemaVersion: 1,
        file: basename,
        sha256: copied.sha256,
        size: copied.size,
        verifiedPath,
        acceptedAt: new Date(this.now()).toISOString()
      };
      const manifestTemp = `${manifestAbsolute}.${randomUUID()}.tmp`;
      await fs.writeFile(manifestTemp, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(manifestTemp, manifestAbsolute);

      return {
        schemaVersion: 1,
        file: basename,
        sha256: copied.sha256,
        size: copied.size,
        verifiedPath,
        manifestPath,
        reused
      };
    } catch (error) {
      await fs.unlink(tempAbsolute).catch(() => undefined);
      throw error;
    }
  }

  async createReceiveOffer(options: {
    workspace: string;
    basePath: string;
    fileName: string;
    expectedSha256: string;
    expectedSize: number;
    ttlMs?: number;
  }): Promise<DataPlaneOffer> {
    this.assertOperational();
    this.policy.assertWrite(options.workspace);
    const fileName = validateFileName(options.fileName);
    const expectedSha256 = normalizeSha256(options.expectedSha256);
    const expectedSize = validateSize(options.expectedSize);
    const ttlMs = Math.min(Math.max(options.ttlMs ?? DEFAULT_TTL_MS, 10_000), MAX_TTL_MS);
    const bindAddress = chooseBindAddress(this.options);
    const baseRoot = await this.paths.resolveExisting(options.workspace, options.basePath);
    const incomingDir = path.join(baseRoot, '.rwmcp', 'transfers', 'incoming');
    await fs.mkdir(incomingDir, { recursive: true });

    const transferId = randomUUID();
    const ticket = randomBytes(32).toString('base64url');
    const incomingRelative = portable(path.join('.rwmcp', 'transfers', 'incoming', `${transferId}-${fileName}`));
    const incomingAbsolute = path.join(baseRoot, ...incomingRelative.split('/'));
    const tempAbsolute = `${incomingAbsolute}.part`;
    const expiresAtMs = this.now() + ttlMs;

    let offer!: ActiveOffer;
    const server = http.createServer((request, response) => {
      void (async () => {
        const fail = (status: number, message: string) => {
          response.statusCode = status;
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({ ok: false, error: message }));
        };

        if (offer.consumed) return fail(410, 'Transfer ticket has already been consumed.');
        if (this.now() >= offer.expiresAtMs) return fail(410, 'Transfer ticket has expired.');
        if (request.method !== 'PUT' || request.url !== `/rwmcp-data/${offer.transferId}`) {
          return fail(404, 'Transfer endpoint not found.');
        }
        if (offer.receiving) return fail(409, 'Transfer is already in progress.');

        const auth = request.headers.authorization ?? '';
        const ticketValue = auth.startsWith('Bearer ') ? auth.slice(7) : '';
        if (!ticketValue || !ticketMatches(offer.ticketHash, ticketValue)) return fail(401, 'Invalid transfer ticket.');

        const contentLengthRaw = request.headers['content-length'];
        const contentLength = typeof contentLengthRaw === 'string' ? Number(contentLengthRaw) : NaN;
        if (!Number.isSafeInteger(contentLength) || contentLength !== offer.expectedSize) {
          return fail(400, `Content-Length must equal expected file size ${offer.expectedSize}.`);
        }
        const declaredSha = typeof request.headers['x-rwmcp-sha256'] === 'string'
          ? request.headers['x-rwmcp-sha256'].trim().toLowerCase()
          : '';
        if (declaredSha !== offer.expectedSha256) return fail(400, 'Declared SHA-256 does not match the receive offer.');

        offer.receiving = true;
        offer.request = request;
        request.setTimeout(ttlMs, () => request.destroy(new Error('Incoming data-plane transfer timed out.')));
        const hash = createHash('sha256');
        let received = 0;
        const meter = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            received += chunk.length;
            if (received > offer.expectedSize || received > MAX_TRANSFER_BYTES) {
              callback(new Error('Incoming file exceeded the declared size.'));
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
          if (actualSha !== offer.expectedSha256) throw new Error(`Received SHA-256 ${actualSha}; expected ${offer.expectedSha256}.`);
          await fs.rename(tempAbsolute, incomingAbsolute);
          const accepted = await this.accept({
            workspace: offer.workspace,
            basePath: offer.basePath,
            file: offer.incomingRelative,
            expectedSha256: offer.expectedSha256,
            expectedSize: offer.expectedSize
          });
          await fs.unlink(incomingAbsolute).catch(() => undefined);
          offer.consumed = true;
          offer.request = undefined;
          this.record({
            transferId: offer.transferId,
            direction: 'receive',
            fileName: offer.fileName,
            sha256: accepted.sha256,
            size: accepted.size,
            status: 'succeeded',
            completedAt: new Date(this.now()).toISOString()
          });
          response.statusCode = 200;
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({ ok: true, schemaVersion: 1, transferId: offer.transferId, accepted }));
          setImmediate(() => { void this.closeOffer(offer); });
        } catch (error) {
          await fs.unlink(tempAbsolute).catch(() => undefined);
          await fs.unlink(incomingAbsolute).catch(() => undefined);
          offer.receiving = false;
          offer.request = undefined;
          this.record({
            transferId: offer.transferId,
            direction: 'receive',
            fileName: offer.fileName,
            sha256: offer.expectedSha256,
            size: offer.expectedSize,
            status: 'failed',
            completedAt: new Date(this.now()).toISOString(),
            error: error instanceof Error ? error.message : String(error)
          });
          fail(400, error instanceof Error ? error.message : String(error));
        }
      })().catch(error => {
        response.statusCode = 500;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      });
    });

    offer = {
      server,
      timer: setTimeout(() => {
        void (async () => {
          offer.consumed = true;
          offer.request?.destroy(new Error('Data-plane receive offer expired.'));
          await this.closeOffer(offer);
          await fs.unlink(tempAbsolute).catch(() => undefined);
          await fs.unlink(incomingAbsolute).catch(() => undefined);
        })();
      }, ttlMs),
      transferId,
      ticketHash: hashTicket(ticket),
      workspace: options.workspace,
      basePath: options.basePath,
      fileName,
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
      throw new Error('Unable to determine native data-plane listener address.');
    }

    return {
      schemaVersion: 1,
      transferId,
      endpoint: `http://${bindAddress}:${address.port}/rwmcp-data/${transferId}`,
      ticket,
      fileName,
      expectedSha256,
      expectedSize,
      expiresAt: new Date(expiresAtMs).toISOString(),
      transport: 'tailscale-http'
    };
  }

  async push(options: {
    workspace: string;
    basePath: string;
    file: string;
    endpoint: string;
    ticket: string;
    expectedSha256: string;
    expectedSize: number;
    timeoutMs?: number;
  }): Promise<DataPlaneReceipt> {
    this.assertOperational();
    const expectedSha256 = normalizeSha256(options.expectedSha256);
    const expectedSize = validateSize(options.expectedSize);
    const endpoint = validatePeerEndpoint(options.endpoint, this.options.allowLoopbackForTests ?? false);
    if (!/^[-_A-Za-z0-9]{32,256}$/.test(options.ticket)) throw new Error('transferTicket has an invalid format.');

    const manifest = await this.prepare(options.workspace, options.basePath, options.file);
    if (manifest.sha256 !== expectedSha256) {
      throw new Error(`Source file SHA-256 mismatch: expected ${expectedSha256}, got ${manifest.sha256}.`);
    }
    if (manifest.size !== expectedSize) {
      throw new Error(`Source file size mismatch: expected ${expectedSize}, got ${manifest.size}.`);
    }
    const absolute = await this.paths.resolveExisting(options.workspace, path.join(options.basePath, manifest.file));
    const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 120_000, 5_000), 10 * 60 * 1000);

    try {
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
        request.setTimeout(timeoutMs, () => request.destroy(new Error('Data-plane transfer timed out.')));
        request.once('error', reject);
        const source = createReadStream(absolute);
        source.once('error', reject);
        source.pipe(request);
      });

      let parsed: unknown;
      try {
        parsed = JSON.parse(response.body);
      } catch {
        throw new Error(`Data-plane receiver returned non-JSON response (HTTP ${response.statusCode}).`);
      }
      if (response.statusCode !== 200) {
        const message = parsed && typeof parsed === 'object' && 'error' in parsed
          ? String((parsed as { error: unknown }).error)
          : response.body;
        throw new Error(`Data-plane receiver rejected transfer (HTTP ${response.statusCode}): ${message}`);
      }
      const record = parsed as { transferId?: unknown; accepted?: DataPlaneAcceptedFile };
      if (typeof record.transferId !== 'string' || !record.accepted) {
        throw new Error('Data-plane receiver response is missing transfer receipt fields.');
      }
      if (record.accepted.sha256 !== manifest.sha256 || record.accepted.size !== manifest.size) {
        throw new Error('Data-plane receiver receipt does not match the source manifest.');
      }
      const receipt: DataPlaneReceipt = {
        schemaVersion: 1,
        transferId: record.transferId,
        transport: 'tailscale-http',
        source: manifest,
        accepted: record.accepted
      };
      this.record({
        transferId: record.transferId,
        direction: 'send',
        fileName: path.basename(manifest.file),
        sha256: manifest.sha256,
        size: manifest.size,
        status: 'succeeded',
        completedAt: new Date(this.now()).toISOString()
      });
      return receipt;
    } catch (error) {
      this.record({
        transferId: randomUUID(),
        direction: 'send',
        fileName: path.basename(options.file),
        sha256: expectedSha256,
        size: expectedSize,
        status: 'failed',
        completedAt: new Date(this.now()).toISOString(),
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  async closeAllForTests(): Promise<void> {
    await Promise.all([...this.active.values()].map(offer => this.closeOffer(offer)));
  }
}
