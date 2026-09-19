import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DataPlaneAdapter, type DataPlaneAcceptedFile } from './data-plane.js';
import { PolicyEngine } from '../policy.js';
import { PathGuard } from '../security/path-guard.js';
import type { CrossNodeTransferIntent } from '../security/multi-node-authorization.js';

const MAX_RELAY_BYTES = 32 * 1024 * 1024;
const MAX_RELAY_CHUNK_BYTES = 64 * 1024;
const DEFAULT_RELAY_TTL_MS = 30 * 60 * 1000;
const MAX_RELAY_TTL_MS = 60 * 60 * 1000;

interface RelayOptions {
  now?: () => number;
}

interface RelaySessionStateV2 {
  schemaVersion: 2;
  sessionId: string;
  fileName: string;
  expectedSha256: string;
  expectedSize: number;
  nextOffset: number;
  expiresAt: string;
  authorization: CrossNodeTransferIntent;
}

export interface RelayBeginResult extends RelaySessionStateV2 {
  transport: 'control-plane-relay';
  maxChunkBytes: number;
}

export interface RelayChunk {
  schemaVersion: 1;
  transport: 'control-plane-relay';
  file: string;
  offset: number;
  length: number;
  nextOffset: number;
  totalSize: number;
  eof: boolean;
  sha256: string;
  dataBase64: string;
}

export interface RelayWriteResult {
  schemaVersion: 1;
  transport: 'control-plane-relay';
  sessionId: string;
  written: number;
  nextOffset: number;
  expectedSize: number;
  complete: boolean;
}

export interface RelayFinalizeResult {
  schemaVersion: 1;
  transport: 'control-plane-relay';
  sessionId: string;
  accepted: DataPlaneAcceptedFile;
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
    throw new Error('SHA-256 must be exactly 64 hexadecimal characters.');
  }
  return normalized;
}

function validateSessionId(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(normalized)) {
    throw new Error('relaySessionId must be a UUID.');
  }
  return normalized;
}

function validateExpectedSize(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_RELAY_BYTES) {
    throw new Error(`expectedSize must be an integer between 1 and ${MAX_RELAY_BYTES} for control-plane relay.`);
  }
  return value;
}

function decodeBase64(value: string): Buffer {
  if (!value || value.length > 90_000 || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('relayDataBase64 is not canonical bounded base64.');
  }
  const decoded = Buffer.from(value, 'base64');
  if (!decoded.length || decoded.length > MAX_RELAY_CHUNK_BYTES) {
    throw new Error(`relay chunk must contain 1..${MAX_RELAY_CHUNK_BYTES} bytes.`);
  }
  if (decoded.toString('base64') !== value) {
    throw new Error('relayDataBase64 is not canonical base64.');
  }
  return decoded;
}

export class ControlPlaneRelayAdapter {
  private readonly now: () => number;

  constructor(
    private readonly policy: PolicyEngine,
    private readonly paths: PathGuard,
    private readonly dataPlane: DataPlaneAdapter,
    options: RelayOptions = {}
  ) {
    this.now = options.now ?? (() => Date.now());
  }

  status() {
    return {
      transport: 'control-plane-relay' as const,
      supported: true,
      maxRelayBytes: MAX_RELAY_BYTES,
      maxChunkBytes: MAX_RELAY_CHUNK_BYTES,
      resumable: true,
      persistentSessionState: true
    };
  }

  private async baseRoot(workspace: string, basePath: string): Promise<string> {
    return await this.paths.resolveExisting(workspace, basePath);
  }

  private sessionDir(baseRoot: string, sessionId: string): string {
    return path.join(baseRoot, '.rwmcp', 'transfers', 'relay', sessionId);
  }

  private statePath(sessionDir: string): string {
    return path.join(sessionDir, 'session.json');
  }

  private async persistState(sessionDir: string, state: RelaySessionStateV2): Promise<void> {
    const target = this.statePath(sessionDir);
    const temp = `${target}.${randomUUID()}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temp, target);
  }

  private async cleanupExpiredSessions(relayRoot: string): Promise<void> {
    try {
      const entries = await fs.readdir(relayRoot, { withFileTypes: true });
      for (const entry of entries.filter(item => item.isDirectory()).slice(0, 128)) {
        const sessionDir = path.join(relayRoot, entry.name);
        try {
          const raw = await fs.readFile(this.statePath(sessionDir), 'utf8');
          const parsed = JSON.parse(raw) as { expiresAt?: unknown };
          if (typeof parsed.expiresAt === 'string') {
            const expiry = Date.parse(parsed.expiresAt);
            if (Number.isFinite(expiry) && this.now() >= expiry) {
              await fs.rm(sessionDir, { recursive: true, force: true });
            }
          }
        } catch {
          // Unknown/corrupt state is left in place for explicit inspection instead of deleting it implicitly.
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }

  private validateState(value: unknown, expectedSessionId: string): RelaySessionStateV2 {
    if (!value || typeof value !== 'object') throw new Error('relay session state is invalid.');
    const state = value as Partial<RelaySessionStateV2>;
    if (
      state.schemaVersion !== 2 ||
      state.sessionId !== expectedSessionId ||
      typeof state.fileName !== 'string' ||
      typeof state.expectedSha256 !== 'string' ||
      typeof state.expectedSize !== 'number' ||
      typeof state.nextOffset !== 'number' ||
      typeof state.expiresAt !== 'string' ||
      !state.authorization ||
      typeof state.authorization !== 'object'
    ) {
      throw new Error('relay session state is invalid.');
    }
    validateFileName(state.fileName);
    normalizeSha256(state.expectedSha256);
    validateExpectedSize(state.expectedSize);
    if (!Number.isSafeInteger(state.nextOffset) || state.nextOffset < 0 || state.nextOffset > state.expectedSize) {
      throw new Error('relay session nextOffset is invalid.');
    }
    const expiry = Date.parse(state.expiresAt);
    if (!Number.isFinite(expiry)) throw new Error('relay session expiry is invalid.');
    return state as RelaySessionStateV2;
  }

  private async loadState(workspace: string, basePath: string, sessionIdRaw: string): Promise<{
    baseRoot: string;
    sessionDir: string;
    payloadPath: string;
    state: RelaySessionStateV2;
  }> {
    const sessionId = validateSessionId(sessionIdRaw);
    const baseRoot = await this.baseRoot(workspace, basePath);
    const sessionDir = this.sessionDir(baseRoot, sessionId);
    let raw: string;
    try {
      raw = await fs.readFile(this.statePath(sessionDir), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('relay session does not exist.');
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('relay session state is invalid JSON.');
    }
    const state = this.validateState(parsed, sessionId);
    if (this.now() >= Date.parse(state.expiresAt)) {
      await fs.rm(sessionDir, { recursive: true, force: true });
      throw new Error('relay session has expired.');
    }

    const payloadPath = path.join(sessionDir, state.fileName);
    const stat = await fs.stat(payloadPath);
    if (!stat.isFile()) throw new Error('relay session payload is not a regular file.');
    if (stat.size > state.expectedSize) throw new Error('relay session payload exceeds expected size.');
    if (stat.size !== state.nextOffset) {
      state.nextOffset = stat.size;
      await this.persistState(sessionDir, state);
    }

    return { baseRoot, sessionDir, payloadPath, state };
  }

  async readChunk(options: {
    workspace: string;
    basePath: string;
    file: string;
    offset: number;
    chunkBytes?: number;
  }): Promise<RelayChunk> {
    if (!Number.isSafeInteger(options.offset) || options.offset < 0) {
      throw new Error('relayOffset must be a non-negative safe integer.');
    }
    const chunkBytes = options.chunkBytes ?? MAX_RELAY_CHUNK_BYTES;
    if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0 || chunkBytes > MAX_RELAY_CHUNK_BYTES) {
      throw new Error(`relayChunkBytes must be between 1 and ${MAX_RELAY_CHUNK_BYTES}.`);
    }

    const relative = options.file;
    if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]+/).includes('..')) {
      throw new Error('file must remain relative to the selected base path.');
    }
    const absolute = await this.paths.resolveExisting(options.workspace, path.join(options.basePath, relative));
    const stat = await fs.stat(absolute);
    if (!stat.isFile()) throw new Error('file must resolve to a regular file.');
    if (stat.size <= 0 || stat.size > MAX_RELAY_BYTES) {
      throw new Error(`control-plane relay supports source files between 1 and ${MAX_RELAY_BYTES} bytes.`);
    }
    if (options.offset > stat.size) throw new Error('relayOffset exceeds source file size.');

    const length = Math.min(chunkBytes, stat.size - options.offset);
    if (length === 0) {
      return {
        schemaVersion: 1,
        transport: 'control-plane-relay',
        file: relative.split(path.sep).join('/'),
        offset: options.offset,
        length: 0,
        nextOffset: options.offset,
        totalSize: stat.size,
        eof: true,
        sha256: createHash('sha256').update(Buffer.alloc(0)).digest('hex'),
        dataBase64: ''
      };
    }

    const handle = await fs.open(absolute, 'r');
    try {
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, options.offset);
      const data = buffer.subarray(0, bytesRead);
      return {
        schemaVersion: 1,
        transport: 'control-plane-relay',
        file: relative.split(path.sep).join('/'),
        offset: options.offset,
        length: bytesRead,
        nextOffset: options.offset + bytesRead,
        totalSize: stat.size,
        eof: options.offset + bytesRead >= stat.size,
        sha256: createHash('sha256').update(data).digest('hex'),
        dataBase64: data.toString('base64')
      };
    } finally {
      await handle.close();
    }
  }

  async begin(options: {
    workspace: string;
    basePath: string;
    fileName: string;
    expectedSha256: string;
    expectedSize: number;
    ttlMs?: number;
    authorization: CrossNodeTransferIntent;
  }): Promise<RelayBeginResult> {
    this.policy.assertWrite(options.workspace);
    const fileName = validateFileName(options.fileName);
    const expectedSha256 = normalizeSha256(options.expectedSha256);
    const expectedSize = validateExpectedSize(options.expectedSize);
    const ttlMs = Math.min(Math.max(options.ttlMs ?? DEFAULT_RELAY_TTL_MS, 60_000), MAX_RELAY_TTL_MS);
    const baseRoot = await this.baseRoot(options.workspace, options.basePath);
    const relayRoot = path.join(baseRoot, '.rwmcp', 'transfers', 'relay');
    await fs.mkdir(relayRoot, { recursive: true });
    await this.cleanupExpiredSessions(relayRoot);

    const sessionId = randomUUID();
    const sessionDir = this.sessionDir(baseRoot, sessionId);
    await fs.mkdir(sessionDir, { recursive: false, mode: 0o700 });
    await fs.writeFile(path.join(sessionDir, fileName), Buffer.alloc(0), { flag: 'wx', mode: 0o600 });
    if (options.authorization.transport !== 'relay') {
      throw new Error('Relay session authorization must use relay transport.');
    }
    const state: RelaySessionStateV2 = {
      schemaVersion: 2,
      sessionId,
      fileName,
      expectedSha256,
      expectedSize,
      nextOffset: 0,
      expiresAt: new Date(this.now() + ttlMs).toISOString(),
      authorization: { ...options.authorization }
    };
    await this.persistState(sessionDir, state);
    return { ...state, transport: 'control-plane-relay', maxChunkBytes: MAX_RELAY_CHUNK_BYTES };
  }

  async sessionStatus(options: {
    workspace: string;
    basePath: string;
    sessionId: string;
  }): Promise<RelayBeginResult> {
    const loaded = await this.loadState(options.workspace, options.basePath, options.sessionId);
    return {
      ...loaded.state,
      transport: 'control-plane-relay',
      maxChunkBytes: MAX_RELAY_CHUNK_BYTES
    };
  }

  async writeChunk(options: {
    workspace: string;
    basePath: string;
    sessionId: string;
    offset: number;
    dataBase64: string;
    chunkSha256: string;
  }): Promise<RelayWriteResult> {
    this.policy.assertWrite(options.workspace);
    if (!Number.isSafeInteger(options.offset) || options.offset < 0) {
      throw new Error('relayOffset must be a non-negative safe integer.');
    }
    const expectedChunkSha = normalizeSha256(options.chunkSha256);
    const data = decodeBase64(options.dataBase64);
    const actualChunkSha = createHash('sha256').update(data).digest('hex');
    if (actualChunkSha !== expectedChunkSha) {
      throw new Error(`relay chunk SHA-256 mismatch: expected ${expectedChunkSha}, got ${actualChunkSha}.`);
    }

    const loaded = await this.loadState(options.workspace, options.basePath, options.sessionId);
    if (options.offset !== loaded.state.nextOffset) {
      throw new Error(`relay offset mismatch: expected ${loaded.state.nextOffset}, got ${options.offset}.`);
    }
    if (options.offset + data.length > loaded.state.expectedSize) {
      throw new Error('relay chunk would exceed expected file size.');
    }

    const handle = await fs.open(loaded.payloadPath, 'r+');
    try {
      let cursor = 0;
      while (cursor < data.length) {
        const { bytesWritten } = await handle.write(data, cursor, data.length - cursor, options.offset + cursor);
        if (bytesWritten <= 0) throw new Error('relay payload write made no progress.');
        cursor += bytesWritten;
      }
      await handle.sync();
    } finally {
      await handle.close();
    }

    loaded.state.nextOffset = options.offset + data.length;
    await this.persistState(loaded.sessionDir, loaded.state);
    return {
      schemaVersion: 1,
      transport: 'control-plane-relay',
      sessionId: loaded.state.sessionId,
      written: data.length,
      nextOffset: loaded.state.nextOffset,
      expectedSize: loaded.state.expectedSize,
      complete: loaded.state.nextOffset === loaded.state.expectedSize
    };
  }

  async finalize(options: {
    workspace: string;
    basePath: string;
    sessionId: string;
  }): Promise<RelayFinalizeResult> {
    this.policy.assertWrite(options.workspace);
    const loaded = await this.loadState(options.workspace, options.basePath, options.sessionId);
    if (loaded.state.nextOffset !== loaded.state.expectedSize) {
      throw new Error(`relay session is incomplete: ${loaded.state.nextOffset}/${loaded.state.expectedSize} bytes.`);
    }

    const relativePayload = path.relative(loaded.baseRoot, loaded.payloadPath);
    const accepted = await this.dataPlane.accept({
      workspace: options.workspace,
      basePath: options.basePath,
      file: relativePayload,
      expectedSha256: loaded.state.expectedSha256,
      expectedSize: loaded.state.expectedSize
    });
    await fs.rm(loaded.sessionDir, { recursive: true, force: true });
    return {
      schemaVersion: 1,
      transport: 'control-plane-relay',
      sessionId: loaded.state.sessionId,
      accepted
    };
  }

  async abort(options: {
    workspace: string;
    basePath: string;
    sessionId: string;
  }): Promise<{ schemaVersion: 1; transport: 'control-plane-relay'; sessionId: string; removed: boolean }> {
    this.policy.assertWrite(options.workspace);
    const sessionId = validateSessionId(options.sessionId);
    const baseRoot = await this.baseRoot(options.workspace, options.basePath);
    const sessionDir = this.sessionDir(baseRoot, sessionId);
    try {
      await fs.access(sessionDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { schemaVersion: 1, transport: 'control-plane-relay', sessionId, removed: false };
      }
      throw error;
    }
    await fs.rm(sessionDir, { recursive: true, force: true });
    return { schemaVersion: 1, transport: 'control-plane-relay', sessionId, removed: true };
  }
}
