import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { LspServerConfig, PolicyConfig } from '../model.js';
import { PolicyEngine } from '../policy.js';
import { PathGuard } from '../security/path-guard.js';
import { buildSafeEnvironment } from '../security/env-filter.js';

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface OpenDocument {
  version: number;
  content: string;
}

interface JsonRpcResponse {
  id?: number | string;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
  method?: string;
  params?: unknown;
}

interface LspLocation {
  uri?: string;
  range?: unknown;
  targetUri?: string;
  targetRange?: unknown;
}

interface LspSessionState {
  client: JsonRpcClient;
  openDocuments: Map<string, OpenDocument>;
  profileId: string;
  workspaceId: string;
  workspaceRoot: string;
  ownerId: string;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

class JsonRpcClient {
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly diagnostics = new Map<string, unknown[]>();
  private stderr = '';
  private exited = false;

  constructor(
    readonly child: ChildProcessWithoutNullStreams,
    private readonly timeoutMs: number,
    private readonly maxMessageBytes: number
  ) {
    child.stdout.on('data', chunk => this.onData(chunk as Buffer));
    child.stderr.on('data', chunk => {
      this.stderr = (this.stderr + chunk.toString('utf8')).slice(-8192);
    });
    child.on('error', error => this.failAll(error));
    child.on('close', code => {
      this.exited = true;
      this.failAll(new Error(`Language server exited with code ${code ?? 'unknown'}.${this.stderr ? ` stderr: ${this.stderr}` : ''}`));
    });
  }

  isAlive(): boolean {
    return !this.exited && this.child.exitCode === null;
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (!this.isAlive()) return Promise.reject(new Error('Language server is not running.'));
    const id = this.nextId++;
    const payload = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request '${method}' timed out after ${this.timeoutMs} ms.`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send(payload);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.isAlive()) throw new Error('Language server is not running.');
    this.send({ jsonrpc: '2.0', method, params });
  }

  getDiagnostics(uri: string): unknown[] {
    return [...(this.diagnostics.get(uri) ?? [])];
  }

  private send(payload: unknown): void {
    const json = JSON.stringify(payload);
    const bytes = Buffer.byteLength(json, 'utf8');
    if (bytes > this.maxMessageBytes) throw new Error(`Outgoing LSP message exceeds ${this.maxMessageBytes} bytes.`);
    this.child.stdin.write(`Content-Length: ${bytes}\r\n\r\n${json}`);
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString('ascii');
      const match = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        this.failAll(new Error('Malformed LSP response: missing Content-Length header.'));
        this.child.kill();
        return;
      }
      const contentLength = Number(match[1]);
      if (!Number.isSafeInteger(contentLength) || contentLength < 0 || contentLength > this.maxMessageBytes) {
        this.failAll(new Error(`Incoming LSP message exceeds ${this.maxMessageBytes} bytes or has invalid length.`));
        this.child.kill();
        return;
      }
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + contentLength;
      if (this.buffer.length < bodyEnd) return;
      const body = this.buffer.subarray(bodyStart, bodyEnd).toString('utf8');
      this.buffer = this.buffer.subarray(bodyEnd);
      try {
        this.onMessage(JSON.parse(body) as JsonRpcResponse);
      } catch (error) {
        this.failAll(error instanceof Error ? error : new Error(String(error)));
        this.child.kill();
        return;
      }
    }
  }

  private onMessage(message: JsonRpcResponse): void {
    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(`LSP error ${message.error.code ?? ''}: ${message.error.message ?? 'unknown error'}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method === 'textDocument/publishDiagnostics' && message.params && typeof message.params === 'object') {
      const params = message.params as { uri?: unknown; diagnostics?: unknown };
      if (typeof params.uri === 'string' && Array.isArray(params.diagnostics)) {
        this.diagnostics.set(params.uri, params.diagnostics.slice(0, 500));
      }
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function normalizedExtensionLanguages(profile: LspServerConfig): Map<string, string> {
  return new Map(Object.entries(profile.languages).map(([extension, language]) => [
    extension.startsWith('.') ? extension.toLowerCase() : `.${extension.toLowerCase()}`,
    language
  ]));
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizeLocation(root: string, value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const location = value as LspLocation;
  const uri = typeof location.uri === 'string' ? location.uri : typeof location.targetUri === 'string' ? location.targetUri : undefined;
  const range = location.range ?? location.targetRange;
  if (!uri || !uri.startsWith('file:')) return { external: true, range };
  try {
    const absolute = fileURLToPath(uri);
    if (!isInside(root, absolute)) return { external: true, range };
    return { path: path.relative(root, absolute).split(path.sep).join('/'), range };
  } catch {
    return { external: true, range };
  }
}

function normalizeLocations(root: string, value: unknown): unknown[] {
  if (value == null) return [];
  return (Array.isArray(value) ? value : [value]).map(item => normalizeLocation(root, item));
}

export class LspAdapter {
  private readonly sessions = new Map<string, LspSessionState>();
  private readonly config: NonNullable<PolicyConfig['lsp']>;

  constructor(
    private readonly policy: PolicyEngine,
    private readonly paths: PathGuard,
    private readonly ownerId: () => string
  ) {
    this.config = policy.config.lsp ?? {
      servers: {},
      requestTimeoutMs: 10_000,
      maxMessageBytes: 2 * 1024 * 1024,
      diagnosticsSettleMs: 250
    };
  }

  listServers(): Array<{ id: string; program: string; languages: Record<string, string> }> {
    return Object.entries(this.config.servers).map(([id, profile]) => ({
      id,
      program: path.basename(profile.program),
      languages: { ...profile.languages }
    }));
  }

  async definition(workspace: string, server: string, file: string, line: number, character: number) {
    const { session, uri } = await this.document(workspace, server, file);
    const raw = await session.client.request('textDocument/definition', {
      textDocument: { uri }, position: { line, character }
    });
    return { locations: normalizeLocations(session.workspaceRoot, raw) };
  }

  async references(workspace: string, server: string, file: string, line: number, character: number, includeDeclaration: boolean) {
    const { session, uri } = await this.document(workspace, server, file);
    const raw = await session.client.request('textDocument/references', {
      textDocument: { uri }, position: { line, character }, context: { includeDeclaration }
    });
    return { locations: normalizeLocations(session.workspaceRoot, raw) };
  }

  async hover(workspace: string, server: string, file: string, line: number, character: number) {
    const { session, uri } = await this.document(workspace, server, file);
    return await session.client.request('textDocument/hover', {
      textDocument: { uri }, position: { line, character }
    });
  }

  async documentSymbols(workspace: string, server: string, file: string) {
    const { session, uri } = await this.document(workspace, server, file);
    return await session.client.request('textDocument/documentSymbol', { textDocument: { uri } });
  }

  async diagnostics(workspace: string, server: string, file: string) {
    const { session, uri } = await this.document(workspace, server, file);
    if (this.config.diagnosticsSettleMs > 0) await sleep(this.config.diagnosticsSettleMs);
    return { diagnostics: session.client.getDiagnostics(uri) };
  }

  private profile(id: string): LspServerConfig {
    const profile = this.config.servers[id];
    if (!profile) throw new Error(`Language server profile '${id}' is not configured.`);
    return profile;
  }

  private sessionKey(owner: string, workspace: string, server: string): string {
    return `${owner}\u0000${workspace}\u0000${server}`;
  }

  private async ensureSession(workspace: string, server: string): Promise<LspSessionState> {
    const owner = this.ownerId();
    const key = this.sessionKey(owner, workspace, server);
    const existing = this.sessions.get(key);
    if (existing?.client.isAlive()) return existing;
    if (existing) this.sessions.delete(key);

    const profile = this.profile(server);
    const ws = this.policy.workspace(workspace);
    this.policy.assertExecute(profile.program);
    const child = spawn(profile.program, profile.args ?? [], {
      cwd: ws.root,
      shell: false,
      windowsHide: true,
      env: buildSafeEnvironment(this.policy.config.process.inheritEnv)
    });
    const client = new JsonRpcClient(child, this.config.requestTimeoutMs, this.config.maxMessageBytes);
    const state: LspSessionState = {
      client,
      openDocuments: new Map(),
      profileId: server,
      workspaceId: workspace,
      workspaceRoot: ws.root,
      ownerId: owner
    };
    this.sessions.set(key, state);

    const rootUri = pathToFileURL(ws.root).href;
    try {
      await client.request('initialize', {
        processId: process.pid,
        clientInfo: { name: 'remote-workstation-mcp', version: '0.7-dev' },
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: ws.name ?? ws.id }],
        capabilities: {
          textDocument: {
            definition: {}, references: {}, hover: {}, documentSymbol: {}, publishDiagnostics: {}
          },
          workspace: { workspaceFolders: true }
        },
        initializationOptions: profile.initializationOptions ?? undefined
      });
      client.notify('initialized', {});
      return state;
    } catch (error) {
      this.sessions.delete(key);
      child.kill();
      throw error;
    }
  }

  private async document(workspace: string, server: string, relativePath: string): Promise<{ session: LspSessionState; uri: string }> {
    const session = await this.ensureSession(workspace, server);
    const profile = this.profile(server);
    const absolute = await this.paths.resolveExisting(workspace, relativePath);
    const stat = await fs.stat(absolute);
    if (!stat.isFile()) throw new Error(`LSP document '${relativePath}' is not a regular file.`);
    if (stat.size > this.policy.config.filesystem.maxReadBytes) {
      throw new Error(`LSP document exceeds filesystem.maxReadBytes (${this.policy.config.filesystem.maxReadBytes}).`);
    }
    const content = await fs.readFile(absolute, 'utf8');
    const uri = pathToFileURL(absolute).href;
    const extension = path.extname(absolute).toLowerCase();
    const languageId = normalizedExtensionLanguages(profile).get(extension);
    if (!languageId) throw new Error(`Language server '${server}' has no language mapping for extension '${extension || '<none>'}'.`);

    const opened = session.openDocuments.get(uri);
    if (!opened) {
      session.client.notify('textDocument/didOpen', {
        textDocument: { uri, languageId, version: 1, text: content }
      });
      session.openDocuments.set(uri, { version: 1, content });
    } else if (opened.content !== content) {
      const version = opened.version + 1;
      session.client.notify('textDocument/didChange', {
        textDocument: { uri, version }, contentChanges: [{ text: content }]
      });
      session.openDocuments.set(uri, { version, content });
    }
    return { session, uri };
  }
}
