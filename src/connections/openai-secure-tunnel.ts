import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import type { ConnectionDescriptor, ConnectionProvider } from './types.js';

export interface OpenAiTunnelProfileOptions {
  tunnelId: string;
  localEndpoint: string;
  runtimeDir: string;
}

export interface OpenAiSecureTunnelOptions {
  localEndpoint?: string;
  runtimeDir?: string;
  tunnelClientPath?: string;
  readyTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

interface PreparedTunnel {
  profilePath: string;
  healthUrlFile: string;
  tunnelBinary: string;
  mcpBearerToken: string;
  tunnelEnv: NodeJS.ProcessEnv;
  mcpEnv: NodeJS.ProcessEnv;
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required for OpenAI Secure MCP Tunnel.`);
  return value;
}

function parsePositiveMs(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > 10 * 60 * 1000) {
    throw new Error('RWMCP_OPENAI_TUNNEL_READY_TIMEOUT_MS must be an integer between 1 and 600000.');
  }
  return value;
}

function stripSensitiveEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized = { ...env };
  for (const key of [
    'CONTROL_PLANE_API_KEY',
    'OPENAI_ADMIN_KEY',
    'OPENAI_API_KEY',
    'RWMCP_TUNNEL_AUTH'
  ]) delete sanitized[key];
  return sanitized;
}

function bearerToken(env: NodeJS.ProcessEnv): string {
  const configured = env.RWMCP_HTTP_BEARER_TOKEN?.trim();
  if (configured) {
    if (configured.length < 32) throw new Error('RWMCP_HTTP_BEARER_TOKEN must be at least 32 characters.');
    return configured;
  }
  return randomBytes(48).toString('base64url');
}

export function buildOpenAiTunnelProfile(options: OpenAiTunnelProfileOptions): Record<string, unknown> {
  return {
    config_version: 1,
    control_plane: {
      tunnel_id: options.tunnelId,
      api_key: 'env:CONTROL_PLANE_API_KEY'
    },
    log: {
      level: 'info',
      format: 'json',
      file: path.join(options.runtimeDir, 'tunnel-client.ndjson')
    },
    health: {
      listen_addr: '127.0.0.1:0',
      url_file: path.join(options.runtimeDir, 'health-url')
    },
    admin_ui: {
      open_browser: false,
      log_buffer_events: 1000
    },
    process: {
      pid_file: path.join(options.runtimeDir, 'tunnel-client.pid')
    },
    cloudflared: {
      managed: true
    },
    mcp: {
      server_urls: [{ channel: 'main', url: options.localEndpoint }],
      extra_headers: {
        Authorization: 'env:RWMCP_TUNNEL_AUTH'
      },
      discovery_extra_headers: {
        Authorization: 'env:RWMCP_TUNNEL_AUTH'
      },
      startup_wait_timeout: '30s',
      connection_max_ttl: '10m',
      max_concurrent_requests: 10
    }
  };
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function resolveTunnelBinary(explicit: string | undefined, runtimeDir: string): Promise<string> {
  if (explicit?.trim()) return explicit.trim();
  const localName = process.platform === 'win32' ? 'tunnel-client.exe' : 'tunnel-client';
  const local = path.join(runtimeDir, localName);
  if (await exists(local)) return local;
  return 'tunnel-client';
}

async function waitForExit(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  return await new Promise(resolve => child.once('close', code => resolve(code)));
}

async function runDoctor(binary: string, profilePath: string, cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  const child = spawn(binary, ['doctor', '--profile-file', profilePath, '--explain'], {
    cwd,
    env,
    shell: false,
    windowsHide: true,
    stdio: 'inherit'
  });
  const code = await waitForExit(child);
  if (code !== 0) throw new Error(`tunnel-client doctor failed with exit code ${code ?? 'unknown'}.`);
}

async function readHealthBase(healthUrlFile: string): Promise<string | undefined> {
  try {
    const value = (await fs.readFile(healthUrlFile, 'utf8')).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

async function waitForUrl(url: string, timeoutMs: number, child?: ChildProcess): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'not ready';
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) {
      throw new Error(`Process exited before readiness with code ${child.exitCode}.`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError}`);
}

async function waitForTunnelReady(healthUrlFile: string, timeoutMs: number, child: ChildProcess): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let healthBase: string | undefined;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`tunnel-client exited before readiness with code ${child.exitCode}.`);
    healthBase = await readHealthBase(healthUrlFile);
    if (healthBase) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!healthBase) throw new Error('tunnel-client did not publish its health URL before the readiness deadline.');
  const readyUrl = `${healthBase.replace(/\/$/, '')}/readyz`;
  await waitForUrl(readyUrl, Math.max(1000, deadline - Date.now()), child);
  return healthBase;
}

function defaultScopes(env: NodeJS.ProcessEnv): string {
  return env.RWMCP_HTTP_SCOPES?.trim() || 'workstation.read,workstation.write,workstation.execute';
}

export class OpenAiSecureTunnelConnectionProvider implements ConnectionProvider {
  readonly descriptor: ConnectionDescriptor;
  private readonly env: NodeJS.ProcessEnv;
  private readonly cwd: string;
  private readonly runtimeDir: string;
  private readonly localEndpoint: string;
  private readonly explicitTunnelBinary?: string;
  private readonly readyTimeoutMs: number;
  private tunnelChild?: ChildProcess;
  private mcpChild?: ChildProcess;

  constructor(options: OpenAiSecureTunnelOptions = {}) {
    this.env = options.env ?? process.env;
    this.cwd = path.resolve(options.cwd ?? process.cwd());
    this.runtimeDir = path.resolve(options.runtimeDir ?? this.env.RWMCP_OPENAI_TUNNEL_DIR ?? path.join(this.cwd, 'runtime', 'openai-tunnel'));
    this.localEndpoint = options.localEndpoint ?? `http://127.0.0.1:${this.env.RWMCP_PORT ?? '8765'}/mcp`;
    this.explicitTunnelBinary = options.tunnelClientPath ?? this.env.RWMCP_OPENAI_TUNNEL_CLIENT;
    this.readyTimeoutMs = options.readyTimeoutMs ?? parsePositiveMs(this.env.RWMCP_OPENAI_TUNNEL_READY_TIMEOUT_MS, 60_000);
    this.descriptor = {
      id: 'openai-secure-mcp-tunnel',
      transport: 'secure-mcp-tunnel',
      exposure: 'outbound-only',
      localEndpoint: this.localEndpoint,
      authentication: 'bearer'
    };
  }

  private async prepare(): Promise<PreparedTunnel> {
    const tunnelId = requiredEnv(this.env, 'CONTROL_PLANE_TUNNEL_ID');
    requiredEnv(this.env, 'CONTROL_PLANE_API_KEY');
    if (!tunnelId.startsWith('tunnel_')) {
      throw new Error("CONTROL_PLANE_TUNNEL_ID must be a tunnel id beginning with 'tunnel_'.");
    }

    await fs.mkdir(this.runtimeDir, { recursive: true });
    const healthUrlFile = path.join(this.runtimeDir, 'health-url');
    await fs.rm(healthUrlFile, { force: true });
    const profilePath = path.join(this.runtimeDir, 'profile.yaml');
    const token = bearerToken(this.env);
    const profile = buildOpenAiTunnelProfile({ tunnelId, localEndpoint: this.localEndpoint, runtimeDir: this.runtimeDir });
    await fs.writeFile(profilePath, YAML.stringify(profile), { encoding: 'utf8', mode: 0o600 });
    if (process.platform !== 'win32') await fs.chmod(profilePath, 0o600);

    const tunnelBinary = await resolveTunnelBinary(this.explicitTunnelBinary, this.runtimeDir);
    const mcpEnv = stripSensitiveEnv(this.env);
    mcpEnv.RWMCP_HTTP_AUTH_MODE = 'bearer';
    mcpEnv.RWMCP_HTTP_BEARER_TOKEN = token;
    mcpEnv.RWMCP_HTTP_PRINCIPAL_ID = this.env.RWMCP_HTTP_PRINCIPAL_ID?.trim() || 'openai-tunnel';
    mcpEnv.RWMCP_HTTP_PRINCIPAL_TYPE = this.env.RWMCP_HTTP_PRINCIPAL_TYPE?.trim() || 'openai-secure-mcp-tunnel';
    mcpEnv.RWMCP_HTTP_SCOPES = defaultScopes(this.env);

    const tunnelEnv = { ...this.env };
    tunnelEnv.RWMCP_TUNNEL_AUTH = `Bearer ${token}`;
    delete tunnelEnv.RWMCP_HTTP_BEARER_TOKEN;

    return { profilePath, healthUrlFile, tunnelBinary, mcpBearerToken: token, tunnelEnv, mcpEnv };
  }

  async start(): Promise<void> {
    if (this.tunnelChild || this.mcpChild) throw new Error('OpenAI secure tunnel connection is already running.');
    const prepared = await this.prepare();
    const cliPath = path.join(this.cwd, 'dist', 'cli.js');
    if (!(await exists(cliPath))) throw new Error(`Built MCP runtime not found at ${cliPath}. Run 'npm run build' first.`);

    this.mcpChild = spawn(process.execPath, [cliPath, '--http'], {
      cwd: this.cwd,
      env: prepared.mcpEnv,
      shell: false,
      windowsHide: true,
      stdio: 'inherit'
    });

    try {
      const healthUrl = this.localEndpoint.replace(/\/mcp$/, '/healthz');
      await waitForUrl(healthUrl, 15_000, this.mcpChild);
      await runDoctor(prepared.tunnelBinary, prepared.profilePath, this.cwd, prepared.tunnelEnv);

      this.tunnelChild = spawn(prepared.tunnelBinary, ['run', '--profile-file', prepared.profilePath], {
        cwd: this.cwd,
        env: prepared.tunnelEnv,
        shell: false,
        windowsHide: true,
        stdio: 'inherit'
      });

      const healthBase = await waitForTunnelReady(prepared.healthUrlFile, this.readyTimeoutMs, this.tunnelChild);
      console.error(`[remote-workstation-mcp] OpenAI Secure MCP Tunnel ready. health=${healthBase} local=${this.localEndpoint}`);
      console.error('[remote-workstation-mcp] MCP bearer is ephemeral for this supervisor run and is not written to the tunnel profile.');
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async wait(): Promise<void> {
    if (!this.mcpChild || !this.tunnelChild) throw new Error('OpenAI secure tunnel connection is not running.');
    const winner = await Promise.race([
      waitForExit(this.mcpChild).then(code => ({ name: 'mcp', code })),
      waitForExit(this.tunnelChild).then(code => ({ name: 'tunnel-client', code }))
    ]);
    await this.stop();
    if (winner.code !== 0 && winner.code !== null) {
      throw new Error(`${winner.name} exited with code ${winner.code}.`);
    }
  }

  async stop(): Promise<void> {
    const children = [this.tunnelChild, this.mcpChild].filter((child): child is ChildProcess => Boolean(child));
    this.tunnelChild = undefined;
    this.mcpChild = undefined;
    for (const child of children) {
      if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
    }
    await Promise.all(children.map(async child => {
      if (child.exitCode !== null) return;
      await Promise.race([
        waitForExit(child),
        new Promise(resolve => setTimeout(resolve, 3000))
      ]);
      if (child.exitCode === null && !child.killed) child.kill('SIGKILL');
    }));
  }
}
