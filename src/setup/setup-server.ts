import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setupHtml } from './ui.js';
import { loadOrCreateDeviceIdentity, recommendedChatGptAppName } from '../device-identity.js';
import { loadHosts } from '../hosts.js';
import { NodeInterlockStore } from '../node-interlock.js';
import { PairingStore } from '../pairing/pairing-store.js';
import { PairingBootstrapAdapter } from '../pairing/pairing-bootstrap.js';
import { QualityObservationStore } from '../quality-learning.js';
import { QualityLearningSettingsStore } from '../quality-learning-policy.js';
import { QualityKnowledgeStore } from '../quality-knowledge.js';
import { OwnerQualityReviewStore, type OwnerQualityDecisionKind } from '../quality-review.js';
import { approveAdminRequest, denyAdminRequest, listAdminRequests } from '../privileged/approval-store.js';
import { linuxOpenAiEnvPath, readEnvFile, readTuiRuntimeState, updateEnvFile } from '../tui/config.js';
import {
  applyOwnerPermissionMode,
  applyPermissionConfig,
  grantFullControlLease,
  readPermissionState,
  revokePermissionLease
} from './permissions.js';
import {
  ensureDefaultPolicy,
  ensureHostsConfig,
  loadSetupSettings,
  normalizeSetupSettings,
  saveSetupSettings,
  setupSecretPath,
  setupSettingsPath,
  type SetupSettings
} from './settings.js';

export interface SetupServerOptions {
  repoRoot?: string;
  port?: number;
  openBrowser?: boolean;
  strictPort?: boolean;
}

interface SetupSaveRequest extends SetupSettings {
  runtimeApiKey?: string;
  storeRuntimeApiKey?: boolean;
}

type RuntimeAction = 'Start' | 'Stop' | 'Restart' | 'RegisterStartup' | 'UnregisterStartup';
type RuntimeMode = 'Local' | 'OpenAI';

const MAX_BODY_BYTES = 64 * 1024;
const MCP_PORT_CANDIDATES = [8683, 8877, 9876, 8765, 18765, 19001, 20080];

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': data.byteLength,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  res.end(data);
}

function html(res: http.ServerResponse, body: string): void {
  const data = Buffer.from(body);
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': data.byteLength,
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer'
  });
  res.end(data);
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new Error('Request body is too large.');
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function allowedOrigin(req: http.IncomingMessage, port: number): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function directoryExists(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

async function portAvailable(port: number): Promise<boolean> {
  return await new Promise<boolean>(resolve => {
    const probe = net.createServer();
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    probe.once('error', () => finish(false));
    probe.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      probe.close(error => finish(!error));
    });
  });
}

async function recommendedMcpPort(configured: number): Promise<number> {
  const candidates = [configured, ...MCP_PORT_CANDIDATES.filter(port => port !== configured)];
  for (const port of candidates) {
    if (await portAvailable(port)) return port;
  }
  for (let port = 21000; port < 21100; port += 1) {
    if (await portAvailable(port)) return port;
  }
  throw new Error('No free loopback MCP port was found in the setup candidate range.');
}

function runProcess(program: string, args: string[], options: { cwd: string; stdin?: string; maxBytes?: number; timeoutMs?: number; env?: NodeJS.ProcessEnv }): Promise<{ code: number; output: string }> {
  const maxBytes = options.maxBytes ?? 128 * 1024;
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: options.env ? { ...process.env, ...options.env } : process.env
    });
    let output = '';
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const append = (chunk: Buffer | string) => {
      if (Buffer.byteLength(output) >= maxBytes) return;
      output += chunk.toString();
      if (Buffer.byteLength(output) > maxBytes) output = output.slice(0, maxBytes);
    };
    const finish = (result: { code: number; output: string }) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.once('error', error => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.once('close', code => finish({ code: code ?? -1, output: output.trim() }));
    if (options.timeoutMs && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        append(`
Process timed out after ${options.timeoutMs} ms.`);
        try { child.kill(); } catch {}
        finish({ code: -2, output: output.trim() });
      }, options.timeoutMs);
      timer.unref?.();
    }
    if (options.stdin !== undefined) child.stdin?.end(options.stdin);
    else child.stdin?.end();
  });
}

async function storeWindowsRuntimeKey(repoRoot: string, secret: string): Promise<void> {
  if (process.platform !== 'win32') throw new Error('Persistent runtime-key storage is currently supported on Windows only.');
  if (secret.length < 20 || /\s/.test(secret)) throw new Error('Runtime API key format is invalid.');
  const script = path.join(repoRoot, 'scripts', 'windows-secret.ps1');
  const secretPath = setupSecretPath();
  const result = await runProcess('powershell.exe', [
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-Action', 'Set', '-Path', secretPath
  ], { cwd: repoRoot, stdin: secret });
  if (result.code !== 0) throw new Error(result.output || `Secret storage failed with exit code ${result.code}.`);
}

async function removeWindowsRuntimeKey(repoRoot: string): Promise<void> {
  if (process.platform !== 'win32') {
    await fs.rm(setupSecretPath(), { force: true });
    return;
  }
  const script = path.join(repoRoot, 'scripts', 'windows-secret.ps1');
  const result = await runProcess('powershell.exe', [
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-Action', 'Delete', '-Path', setupSecretPath()
  ], { cwd: repoRoot });
  if (result.code !== 0) throw new Error(result.output || `Secret removal failed with exit code ${result.code}.`);
}

function parseJsonOutput(output: string): unknown {
  const lines = output.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(lines[index]); } catch {}
  }
  throw new Error(output || 'Runtime control returned no JSON status.');
}

async function windowsRuntimeControl(repoRoot: string, action: RuntimeAction | 'Status', mode: RuntimeMode = 'OpenAI'): Promise<unknown> {
  if (process.platform !== 'win32') {
    return { supported: false, running: false, message: 'Windows runtime control is available on Windows only.' };
  }
  const script = path.join(repoRoot, 'scripts', 'runtime-control-windows.ps1');
  const args = [
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-Action', action,
    '-Mode', mode,
    '-Root', repoRoot,
    '-Json'
  ];
  const result = await runProcess('powershell.exe', args, { cwd: repoRoot, maxBytes: 256 * 1024, timeoutMs: action === 'Status' ? 5000 : 30000 });
  if (result.code !== 0) throw new Error(result.output || `Runtime control '${action}' failed with exit code ${result.code}.`);
  return parseJsonOutput(result.output);
}

async function safeWindowsRuntimeStatus(repoRoot: string): Promise<Record<string, unknown>> {
  try {
    return await windowsRuntimeControl(repoRoot, 'Status') as Record<string, unknown>;
  } catch (error) {
    return {
      supported: process.platform === 'win32',
      running: false,
      mcpHealthy: false,
      tunnelReady: false,
      connectionState: 'OFFLINE',
      connectionReason: 'runtime-control-unavailable',
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function readWindowsRuntimeKey(repoRoot: string): Promise<string | null> {
  if (process.platform !== 'win32') return null;
  const script = path.join(repoRoot, 'scripts', 'windows-secret.ps1');
  const secretPath = setupSecretPath();
  if (!(await pathExists(secretPath))) return null;
  const result = await runProcess('powershell.exe', [
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-Action', 'Get', '-Path', secretPath
  ], { cwd: repoRoot, maxBytes: 16 * 1024, timeoutMs: 5000 });
  if (result.code !== 0) throw new Error(result.output || `Secret read failed with exit code ${result.code}.`);
  const value = result.output.trim();
  return value || null;
}

function linuxDataHome(): string {
  return path.resolve(process.env.RWMCP_HOME?.trim() || path.join(os.homedir(), '.local', 'share', 'remote-workstation-mcp'));
}

function linuxSystemdEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  const runtimeDir = env.XDG_RUNTIME_DIR || (uid !== undefined ? `/run/user/${uid}` : undefined);
  if (runtimeDir) {
    env.XDG_RUNTIME_DIR = runtimeDir;
    env.DBUS_SESSION_BUS_ADDRESS ||= `unix:path=${runtimeDir}/bus`;
  }
  return env;
}

function tunnelClientPath(repoRoot: string): string {
  return process.platform === 'win32'
    ? path.join(repoRoot, 'runtime', 'openai-tunnel', 'tunnel-client.exe')
    : path.join(linuxDataHome(), 'runtime', 'openai-tunnel', 'tunnel-client');
}

async function runtimeKeyStored(repoRoot: string): Promise<boolean> {
  if (process.platform === 'win32') return await pathExists(setupSecretPath());
  const envFile = await readEnvFile(linuxOpenAiEnvPath());
  return Boolean(envFile.get('CONTROL_PLANE_API_KEY'));
}

async function readRuntimeKey(repoRoot: string): Promise<string | null> {
  if (process.platform === 'win32') return await readWindowsRuntimeKey(repoRoot);
  const envFile = await readEnvFile(linuxOpenAiEnvPath());
  return envFile.get('CONTROL_PLANE_API_KEY')?.trim() || null;
}

async function storeRuntimeKey(repoRoot: string, secret: string): Promise<void> {
  if (secret.length < 20 || /\s/.test(secret)) throw new Error('Runtime API key format is invalid.');
  if (process.platform === 'win32') {
    await storeWindowsRuntimeKey(repoRoot, secret);
    return;
  }
  await updateEnvFile(linuxOpenAiEnvPath(), { CONTROL_PLANE_API_KEY: secret });
}

async function removeRuntimeKey(repoRoot: string): Promise<void> {
  if (process.platform === 'win32') {
    await removeWindowsRuntimeKey(repoRoot);
    return;
  }
  await updateEnvFile(linuxOpenAiEnvPath(), { CONTROL_PLANE_API_KEY: undefined });
}

async function syncLinuxDirectNodeSettings(settings: SetupSettings): Promise<void> {
  if (process.platform === 'win32') return;
  await updateEnvFile(linuxOpenAiEnvPath(), {
    CONTROL_PLANE_TUNNEL_ID: settings.tunnelId || undefined,
    RWMCP_PORT: String(settings.mcpPort),
    RWMCP_HTTP_SCOPES: settings.httpScopes.join(',')
  });
}

async function loadEffectiveSetupSettings(repoRoot: string): Promise<SetupSettings> {
  const settings = await loadSetupSettings();
  if (process.platform === 'win32') return settings;
  const envFile = await readEnvFile(linuxOpenAiEnvPath());
  const tui = await readTuiRuntimeState(repoRoot);
  const envPort = Number(envFile.get('RWMCP_PORT'));
  const scopes = (envFile.get('RWMCP_HTTP_SCOPES') || tui.httpScopes.join(','))
    .split(',').map(value => value.trim()).filter(Boolean);
  return normalizeSetupSettings({
    ...settings,
    mcpPort: Number.isInteger(envPort) && envPort >= 1024 && envPort <= 65535 ? envPort : tui.mcpPort,
    workspaceRoot: tui.workspaceRoot && tui.workspaceRoot !== '-' ? tui.workspaceRoot : settings.workspaceRoot,
    tunnelId: envFile.get('CONTROL_PLANE_TUNNEL_ID') || settings.tunnelId,
    httpScopes: scopes.length ? scopes : settings.httpScopes
  });
}
async function linuxRuntimeStatus(repoRoot: string): Promise<Record<string, unknown>> {
  const state = await readTuiRuntimeState(repoRoot);
  const systemdEnv = linuxSystemdEnv();
  const directUnit = 'remote-workstation-mcp-openai.service';
  const localUnit = 'remote-workstation-mcp.service';
  const directEnabled = await runProcess('systemctl', ['--user', 'is-enabled', directUnit], { cwd: repoRoot, env: systemdEnv, timeoutMs: 4000 });
  const localEnabled = await runProcess('systemctl', ['--user', 'is-enabled', localUnit], { cwd: repoRoot, env: systemdEnv, timeoutMs: 4000 });
  const startupRegistered = directEnabled.code === 0 || localEnabled.code === 0;
  let mcpHealthy = false;
  let mcpVersion = '';
  let httpAuth = '';
  try {
    const response = await fetch(`http://127.0.0.1:${state.mcpPort}/healthz`, { signal: AbortSignal.timeout(1500) });
    if (response.ok) {
      const health = await response.json() as { ok?: boolean; version?: string; httpAuth?: string };
      mcpHealthy = health.ok === true;
      mcpVersion = health.version || '';
      httpAuth = health.httpAuth || '';
    }
  } catch {}
  const running = state.service === 'active';
  const tunnelReady = state.tunnelReady === true;
  return {
    supported: true,
    running,
    mode: directEnabled.code === 0 ? 'OpenAI' : 'Local',
    root: repoRoot,
    port: state.mcpPort,
    mcpHealthy,
    mcpVersion,
    httpAuth,
    tunnelReady,
    connectionState: tunnelReady ? 'ONLINE' : (running ? 'RECONNECTING' : 'OFFLINE'),
    connectionReason: tunnelReady ? 'tunnel-ready' : (running ? 'tunnel-not-ready' : 'runtime-stopped'),
    reconnectAttempt: 0,
    startupRegistered,
    startupMethod: 'systemd-user'
  };
}

async function assertNoActiveWorkSessionInterlocks(operation: string): Promise<void> {
  const store = new NodeInterlockStore('owner-local-lifecycle');
  await store.reconcileStale();
  const active = await store.listActive();
  if (active.length === 0) return;
  const labels = active.slice(0, 5).map(item => item.label).join(', ');
  throw new Error(
    `NODE_BUSY: ${active.length} active Work Session workflow interlock(s) prevent ${operation}. ` +
    `Active: ${labels || 'workflow'}. Finish/cancel the typed workflow first; lifecycle operations do not implicitly override critical work.`
  );
}

async function linuxRuntimeControl(repoRoot: string, action: RuntimeAction | 'Status', mode: RuntimeMode = 'OpenAI'): Promise<unknown> {
  if (action === 'Status') return await linuxRuntimeStatus(repoRoot);
  if (action === 'Restart') await assertNoActiveWorkSessionInterlocks('runtime restart');
  const env = linuxSystemdEnv();
  const unit = mode === 'OpenAI' ? 'remote-workstation-mcp-openai.service' : 'remote-workstation-mcp.service';
  const argsByAction: Record<RuntimeAction, string[]> = {
    Start: ['--user', 'start', unit],
    Stop: ['--user', 'stop', unit],
    Restart: ['--user', 'restart', unit],
    RegisterStartup: ['--user', 'enable', unit],
    UnregisterStartup: ['--user', 'disable', unit]
  };
  const result = await runProcess('systemctl', argsByAction[action], { cwd: repoRoot, env, timeoutMs: 30000, maxBytes: 128 * 1024 });
  if (result.code !== 0) throw new Error(result.output || `systemctl ${action} failed for ${unit}.`);
  if (action === 'Start' || action === 'Restart') await new Promise(resolve => setTimeout(resolve, 500));
  return await linuxRuntimeStatus(repoRoot);
}

async function runtimeControl(repoRoot: string, action: RuntimeAction | 'Status', mode: RuntimeMode = 'OpenAI'): Promise<unknown> {
  return process.platform === 'win32'
    ? await windowsRuntimeControl(repoRoot, action, mode)
    : await linuxRuntimeControl(repoRoot, action, mode);
}

async function safeRuntimeStatus(repoRoot: string): Promise<Record<string, unknown>> {
  try {
    return await runtimeControl(repoRoot, 'Status') as Record<string, unknown>;
  } catch (error) {
    return {
      supported: true,
      running: false,
      mcpHealthy: false,
      tunnelReady: false,
      connectionState: 'OFFLINE',
      connectionReason: 'runtime-control-unavailable',
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
async function testOpenAiTunnel(repoRoot: string, tunnelId: string, runtimeApiKey?: string): Promise<{ ok: boolean; tunnelId: string; message: string }> {
  if (!/^tunnel_[0-9a-f]{32}$/.test(tunnelId)) {
    return { ok: false, tunnelId, message: "Tunnel ID must match 'tunnel_' followed by 32 lowercase hexadecimal characters." };
  }
  const tunnelClient = tunnelClientPath(repoRoot);
  if (!(await pathExists(tunnelClient))) {
    return { ok: false, tunnelId, message: 'OpenAI tunnel-client is not installed in this runtime slot.' };
  }
  const key = runtimeApiKey?.trim() || await readRuntimeKey(repoRoot);
  if (!key) return { ok: false, tunnelId, message: 'No runtime API key is available. Paste a restricted key with Tunnels Read + Use.' };
  if (key.length < 20 || /\s/.test(key)) return { ok: false, tunnelId, message: 'Runtime API key format is invalid.' };
  const result = await runProcess(tunnelClient, ['admin', 'tunnels', 'get', tunnelId, '--json'], {
    cwd: repoRoot,
    maxBytes: 64 * 1024,
    timeoutMs: 15000,
    env: { CONTROL_PLANE_API_KEY: key, OPENAI_API_KEY: key }
  });
  if (result.code !== 0) {
    const message = result.output || `tunnel-client verification failed with exit code ${result.code}.`;
    return { ok: false, tunnelId, message };
  }
  return { ok: true, tunnelId, message: 'Runtime API key can read this OpenAI Secure MCP Tunnel.' };
}

async function installTunnelClient(repoRoot: string): Promise<string> {
  const result = process.platform === 'win32'
    ? await runProcess('powershell.exe', [
        '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(repoRoot, 'scripts', 'install-openai-tunnel-windows.ps1')
      ], { cwd: repoRoot, maxBytes: 256 * 1024, timeoutMs: 90000 })
    : await runProcess('bash', [path.join(repoRoot, 'scripts', 'install-openai-tunnel-linux.sh')], {
        cwd: repoRoot,
        maxBytes: 256 * 1024,
        timeoutMs: 90000,
        env: linuxSystemdEnv()
      });
  if (result.code !== 0) throw new Error(result.output || `Tunnel-client installer exited with code ${result.code}.`);
  return result.output;
}

async function enableAutomaticUpdates(repoRoot: string): Promise<unknown> {
  if (process.platform === 'win32') return await updateControl(repoRoot, 'Enable');
  const updateEnv = path.join(path.dirname(linuxOpenAiEnvPath()), 'update.env');
  await updateEnvFile(updateEnv, {
    RWMCP_UPDATE_MODE: 'auto_patch',
    RWMCP_UPDATE_REPO: 'Tunglam0605/remote-workstation-mcp'
  });
  const result = await runProcess('systemctl', ['--user', 'enable', '--now', 'remote-workstation-mcp-update.timer'], {
    cwd: repoRoot,
    env: linuxSystemdEnv(),
    timeoutMs: 15000,
    maxBytes: 64 * 1024
  });
  if (result.code !== 0) throw new Error(result.output || 'Failed to enable the Linux automatic update timer.');
  return { supported: true, enabled: true, mode: 'auto_patch' };
}

async function waitForRuntimeReady(repoRoot: string, timeoutMs = 35000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let last = await safeRuntimeStatus(repoRoot);
  while (Date.now() < deadline) {
    if (last.running === true && last.mcpHealthy === true && last.tunnelReady === true && last.httpAuth === 'bearer') return last;
    await new Promise(resolve => setTimeout(resolve, 500));
    last = await safeRuntimeStatus(repoRoot);
  }
  return last;
}

async function bootstrapWorkstation(repoRoot: string, tunnelId: string, runtimeApiKey: string): Promise<Record<string, unknown>> {
  const tunnel = tunnelId.trim();
  const key = runtimeApiKey.trim();
  if (!/^tunnel_[0-9a-f]{32}$/.test(tunnel)) throw new Error("Tunnel ID must match 'tunnel_' followed by 32 lowercase hexadecimal characters.");
  if (key.length < 20 || /\s/.test(key)) throw new Error('Runtime API key format is invalid.');

  const currentSettings = await loadEffectiveSetupSettings(repoRoot);
  await fs.mkdir(currentSettings.workspaceRoot, { recursive: true });
  await ensureDefaultPolicy(repoRoot, currentSettings.workspaceRoot);
  await ensureHostsConfig(repoRoot);

  const installerOutput = await installTunnelClient(repoRoot);
  const credentialTest = await testOpenAiTunnel(repoRoot, tunnel, key);
  if (!credentialTest.ok) throw new Error(credentialTest.message);

  const settings = normalizeSetupSettings({ ...currentSettings, tunnelId: tunnel });
  await saveSetupSettings(settings);
  const identity = await loadOrCreateDeviceIdentity();

  if (process.platform === 'win32') {
    await storeRuntimeKey(repoRoot, key);
    await enableAutomaticUpdates(repoRoot);
    const before = await safeRuntimeStatus(repoRoot);
    if (before.running === true) await windowsRuntimeControl(repoRoot, 'Restart', 'OpenAI');
    else await windowsRuntimeControl(repoRoot, 'Start', 'OpenAI');
    await windowsRuntimeControl(repoRoot, 'RegisterStartup', 'OpenAI');
  } else {
    const script = path.join(repoRoot, 'scripts', 'setup-direct-node-linux.sh');
    const result = await runProcess('bash', [
      script,
      '--tunnel-id', tunnel,
      '--name', identity.name,
      '--port', String(settings.mcpPort)
    ], {
      cwd: repoRoot,
      env: { ...linuxSystemdEnv(), CONTROL_PLANE_API_KEY: key },
      timeoutMs: 90000,
      maxBytes: 512 * 1024
    });
    if (result.code !== 0) throw new Error(result.output || `Linux Direct Node setup exited with code ${result.code}.`);
    await enableAutomaticUpdates(repoRoot);
  }

  const runtime = await waitForRuntimeReady(repoRoot);
  const ready = runtime.running === true && runtime.mcpHealthy === true && runtime.tunnelReady === true && runtime.httpAuth === 'bearer';
  return {
    ok: ready,
    ready,
    deviceName: identity.name,
    recommendedAppName: recommendedChatGptAppName(identity),
    settings: { ...settings, tunnelId: tunnel },
    runtime,
    automaticUpdates: process.platform === 'win32' ? 'stable' : 'auto_patch',
    tunnelClientInstalled: true,
    installerOutput
  };
}
type WindowsRestartTransaction = Record<string, unknown> & {
  state?: string;
  workerPid?: number;
  updatedAt?: string;
};

function windowsRestartTransactionPath(): string | null {
  const base = windowsManagedBase();
  return base ? path.join(base, 'runtime', 'restart-transaction.json') : null;
}

async function readWindowsRestartTransaction(): Promise<WindowsRestartTransaction | null> {
  if (process.platform !== 'win32') return null;
  const file = windowsRestartTransactionPath();
  if (!file) return null;
  try {
    return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '')) as WindowsRestartTransaction;
  } catch {
    return null;
  }
}

function activeWindowsRestartTransaction(transaction: WindowsRestartTransaction | null): boolean {
  return Boolean(transaction && (transaction.state === 'RUNNING' || transaction.state === 'STARTING'));
}

async function waitForWindowsRestartWorker(workerPid: number, timeoutMs = 1500): Promise<WindowsRestartTransaction | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const transaction = await readWindowsRestartTransaction();
    if (transaction && Number(transaction.workerPid) === workerPid && ['RUNNING', 'SUCCEEDED', 'FAILED'].includes(String(transaction.state ?? ''))) {
      return transaction;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return null;
}

async function scheduleWindowsRuntimeRestart(repoRoot: string, mode: RuntimeMode = 'OpenAI'): Promise<Record<string, unknown>> {
  if (process.platform !== 'win32') {
    throw new Error('Windows runtime restart handoff is available on Windows only.');
  }
  const existing = await readWindowsRestartTransaction();
  if (activeWindowsRestartTransaction(existing)) {
    return { accepted: true, action: 'Restart', mode, alreadyRunning: true, transaction: existing };
  }
  const base = windowsManagedBase();
  if (!base) throw new Error('LOCALAPPDATA is unavailable; durable Windows restart handoff cannot be scheduled.');
  const script = path.join(repoRoot, 'scripts', 'runtime-restart-handoff-windows.ps1');
  if (!(await pathExists(script))) throw new Error(`Windows restart handoff helper is missing: ${script}`);
  const child = spawn('powershell.exe', [
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-Root', repoRoot, '-Mode', mode, '-Base', base
  ], {
    cwd: repoRoot,
    shell: false,
    windowsHide: true,
    detached: true,
    stdio: 'ignore'
  });
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  const workerPid = child.pid;
  child.unref();
  if (!workerPid) throw new Error('Windows restart worker started without a process id.');
  const transaction = await waitForWindowsRestartWorker(workerPid);
  if (!transaction) throw new Error('Windows restart worker did not acknowledge startup.');
  return { accepted: true, action: 'Restart', mode, alreadyRunning: false, transaction };
}

type UpdateAction = 'Status' | 'Check' | 'Enable' | 'Disable' | 'Install';

type WindowsUpdateTransaction = Record<string, unknown> & {
  state?: string;
  workerPid?: number;
  updatedAt?: string;
};

function windowsManagedBase(): string | null {
  const localBase = process.env.LOCALAPPDATA?.trim();
  return localBase ? path.join(localBase, 'RemoteWorkstationMCP') : null;
}

function windowsUpdateTransactionPath(): string | null {
  const base = windowsManagedBase();
  return base ? path.join(base, 'runtime', 'update-transaction.json') : null;
}

async function readWindowsUpdateTransaction(): Promise<WindowsUpdateTransaction | null> {
  if (process.platform !== 'win32') return null;
  const file = windowsUpdateTransactionPath();
  if (!file) return null;
  try {
    const transaction = JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '')) as WindowsUpdateTransaction;
    const state = String(transaction.state ?? '');
    if (state === 'STARTING' || state === 'RUNNING') {
      const updatedAt = Date.parse(String(transaction.updatedAt ?? ''));
      const ageMs = Number.isFinite(updatedAt) ? Date.now() - updatedAt : Number.POSITIVE_INFINITY;
      if (state === 'STARTING' && !Number.isInteger(transaction.workerPid) && ageMs > 30_000) {
        return { ...transaction, stale: true, staleReason: 'starter-never-acknowledged' };
      }
      if (ageMs > 15 * 60 * 1000) {
        return { ...transaction, stale: true, staleReason: 'transaction-timeout' };
      }
    }
    return transaction;
  } catch {
    return null;
  }
}

function activeWindowsUpdateTransaction(transaction: WindowsUpdateTransaction | null): boolean {
  if (!transaction || transaction.stale === true) return false;
  return transaction.state === 'STARTING' || transaction.state === 'RUNNING';
}

async function scheduleWindowsUpdateInstall(repoRoot: string, expectedVersion: string): Promise<Record<string, unknown>> {
  if (process.platform !== 'win32') throw new Error('Windows update handoff is available on Windows only.');
  const existing = await readWindowsUpdateTransaction();
  if (activeWindowsUpdateTransaction(existing)) {
    return { accepted: true, alreadyRunning: true, transaction: existing };
  }

  const base = windowsManagedBase();
  if (!base) throw new Error('LOCALAPPDATA is unavailable; durable Windows update handoff cannot be scheduled.');
  const worker = path.join(repoRoot, 'scripts', 'update-handoff-windows.ps1');
  const starter = path.join(repoRoot, 'scripts', 'start-update-handoff-windows.ps1');
  if (!(await pathExists(worker))) throw new Error(`Windows update handoff helper is missing: ${worker}`);
  if (!(await pathExists(starter))) throw new Error(`Windows durable worker starter is missing: ${starter}`);

  const normalizedExpectedVersion = expectedVersion.replace(/^v/, '');
  const transactionPath = windowsUpdateTransactionPath();
  const transaction = {
    version: 1,
    state: 'STARTING',
    workerPid: null,
    expectedVersion: normalizedExpectedVersion || null,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  if (transactionPath) {
    await fs.mkdir(path.dirname(transactionPath), { recursive: true });
    await fs.writeFile(transactionPath, `${JSON.stringify(transaction, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }

  const args = [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', starter,
    '-RepoRoot', repoRoot,
    '-Base', base,
    '-ExpectedVersion', normalizedExpectedVersion,
    '-AckTimeoutSeconds', '10'
  ];

  const started = await runProcess('powershell.exe', args, {
    cwd: repoRoot,
    maxBytes: 64 * 1024,
    timeoutMs: 15_000
  });

  if (started.code !== 0) {
    const current = await readWindowsUpdateTransaction();
    if (transactionPath && (!current || current.state === 'STARTING')) {
      const failed = {
        ...transaction,
        state: 'FAILED',
        updatedAt: new Date().toISOString(),
        message: started.output || `Durable Windows update starter failed with exit code ${started.code}.`
      };
      await fs.writeFile(transactionPath, `${JSON.stringify(failed, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    }
    throw new Error(started.output || `Durable Windows update starter failed with exit code ${started.code}.`);
  }

  const starterStatus = parseJsonOutput(started.output) as { workerPid?: number; acknowledged?: boolean; state?: string };
  if (starterStatus.acknowledged !== true || !Number.isInteger(starterStatus.workerPid) || Number(starterStatus.workerPid) <= 0) {
    throw new Error('Durable Windows update starter returned without a valid worker acknowledgement.');
  }

  const acknowledged = await readWindowsUpdateTransaction();
  if (!acknowledged || !['RUNNING', 'SUCCEEDED'].includes(String(acknowledged.state))) {
    throw new Error(`Durable Windows update worker did not reach RUNNING/SUCCEEDED; transaction state is '${String(acknowledged?.state ?? 'missing')}'.`);
  }

  return {
    accepted: true,
    alreadyRunning: false,
    transaction: acknowledged
  };
}

async function windowsUpdateControl(repoRoot: string, action: UpdateAction): Promise<unknown> {
  if (action === 'Install') await assertNoActiveWorkSessionInterlocks('runtime update');
  if (process.platform !== 'win32') {
    return { supported: false, enabled: false, message: 'Windows update control is available on Windows only.' };
  }
  const script = path.join(repoRoot, 'scripts', 'update-windows.ps1');
  if (!(await pathExists(script))) {
    return { supported: false, enabled: false, message: 'Windows update helper is not installed in this runtime.' };
  }

  const effectiveAction = action === 'Install' ? 'Check' : action;
  const result = await runProcess('powershell.exe', [
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-Action', effectiveAction,
    '-Json'
  ], { cwd: repoRoot, maxBytes: 128 * 1024, timeoutMs: 30000 });
  if (result.code !== 0) throw new Error(result.output || `Windows update action '${action}' failed with exit code ${result.code}.`);
  const status = parseJsonOutput(result.output) as Record<string, unknown>;

  if (action === 'Install') {
    if (status.updateAvailable !== true) {
      return { supported: true, ...status, accepted: false, transaction: await readWindowsUpdateTransaction() };
    }
    const expectedVersion = typeof status.latestVersion === 'string' ? status.latestVersion : '';
    return { supported: true, ...status, ...(await scheduleWindowsUpdateInstall(repoRoot, expectedVersion)) };
  }

  return { supported: true, ...status, transaction: await readWindowsUpdateTransaction() };
}

async function linuxUpdateControl(repoRoot: string, action: UpdateAction): Promise<unknown> {
  if (action === 'Install') await assertNoActiveWorkSessionInterlocks('runtime update');
  if (process.platform === 'win32') {
    return { supported: false, enabled: false, message: 'Linux update control is available on Linux only.' };
  }
  const updateEnv = path.join(path.dirname(linuxOpenAiEnvPath()), 'update.env');
  const updater = path.join(repoRoot, 'scripts', 'update-user.mjs');
  if (!(await pathExists(updater))) {
    return { supported: false, enabled: false, message: 'Linux update helper is not installed in this runtime.' };
  }
  const envFile = await readEnvFile(updateEnv);
  let mode = envFile.get('RWMCP_UPDATE_MODE')?.trim() || 'notify';
  const repository = envFile.get('RWMCP_UPDATE_REPO')?.trim() || 'Tunglam0605/remote-workstation-mcp';

  if (action === 'Enable' || action === 'Disable') {
    mode = action === 'Enable' ? 'auto_patch' : 'notify';
    await updateEnvFile(updateEnv, {
      RWMCP_UPDATE_MODE: mode,
      RWMCP_UPDATE_REPO: repository
    });
    const timer = await runProcess('systemctl', ['--user', 'enable', '--now', 'remote-workstation-mcp-update.timer'], {
      cwd: repoRoot,
      env: linuxSystemdEnv(),
      timeoutMs: 15000,
      maxBytes: 64 * 1024
    });
    if (timer.code !== 0) throw new Error(timer.output || 'Failed to enable the Linux update timer.');
  }

  if (action === 'Install') {
    const install = await runProcess(process.execPath, [updater], {
      cwd: repoRoot,
      env: { ...linuxSystemdEnv(), RWMCP_UPDATE_MODE: mode, RWMCP_UPDATE_REPO: repository },
      timeoutMs: 180000,
      maxBytes: 512 * 1024
    });
    if (install.code !== 0) throw new Error(install.output || `Linux update install failed with exit code ${install.code}.`);
  }

  if (action === 'Check' || action === 'Install') {
    const check = await runProcess(process.execPath, [updater, '--check'], {
      cwd: repoRoot,
      env: { ...linuxSystemdEnv(), RWMCP_UPDATE_MODE: mode, RWMCP_UPDATE_REPO: repository },
      timeoutMs: 30000,
      maxBytes: 128 * 1024
    });
    if (check.code !== 0) throw new Error(check.output || `Linux update check failed with exit code ${check.code}.`);
    const status = JSON.parse(check.output.trim()) as Record<string, unknown>;
    return {
      supported: true,
      ...status,
      enabled: mode === 'auto_patch',
      channel: 'stable',
      automaticPolicy: 'patch',
      automaticInstallAllowed: status.updateAvailable === true && status.updateKind === 'patch' && mode === 'auto_patch'
    };
  }

  let installedVersion: string | undefined;
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8')) as { version?: string };
    installedVersion = manifest.version;
  } catch {}
  return {
    supported: true,
    enabled: mode === 'auto_patch',
    mode,
    channel: 'stable',
    automaticPolicy: 'patch',
    installedVersion,
    updateAvailable: false
  };
}

async function updateControl(repoRoot: string, action: UpdateAction): Promise<unknown> {
  return process.platform === 'win32'
    ? await windowsUpdateControl(repoRoot, action)
    : await linuxUpdateControl(repoRoot, action);
}

async function openBrowser(url: string): Promise<void> {
  try {
    if (process.platform === 'win32') {
      const child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, shell: false, windowsHide: true, stdio: 'ignore' });
      child.unref();
    } else if (process.platform === 'darwin') {
      const child = spawn('open', [url], { detached: true, shell: false, stdio: 'ignore' });
      child.unref();
    } else {
      const child = spawn('xdg-open', [url], { detached: true, shell: false, stdio: 'ignore' });
      child.unref();
    }
  } catch {
    // The printed URL remains the supported fallback.
  }
}

async function listen(server: http.Server, preferredPort: number, strictPort = false): Promise<number> {
  const candidates = strictPort
    ? [preferredPort]
    : Array.from({ length: 20 }, (_, index) => preferredPort + index).filter(port => port <= 65535);
  for (const port of candidates) {
    if (!(await portAvailable(port))) continue;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => { server.off('listening', onListening); reject(error); };
        const onListening = () => { server.off('error', onError); resolve(); };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, '127.0.0.1');
      });
      return port;
    } catch {
      continue;
    }
  }
  throw new Error(`No available setup port found starting at ${preferredPort}.`);
}

export async function startSetupServer(options: SetupServerOptions = {}): Promise<{ url: string; port: number; close: () => Promise<void> }> {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const preferredPort = options.port ?? Number(process.env.RWMCP_SETUP_PORT ?? 8684);
  if (!Number.isInteger(preferredPort) || preferredPort < 1024 || preferredPort > 65535) {
    throw new Error('RWMCP_SETUP_PORT must be an integer between 1024 and 65535.');
  }
  if (process.platform !== 'win32') {
    const effective = await loadEffectiveSetupSettings(repoRoot);
    await saveSetupSettings(effective);
  }
  const token = crypto.randomBytes(32).toString('base64url');
  let boundPort = preferredPort;

  const server = http.createServer(async (req, res) => {
    try {
      if (!req.socket.remoteAddress || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) {
        json(res, 403, { error: 'Setup console accepts loopback clients only.' });
        return;
      }
      if (!allowedOrigin(req, boundPort)) {
        json(res, 403, { error: 'Origin is not allowed.' });
        return;
      }
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${boundPort}`);
      if (url.pathname === '/' && req.method === 'GET') {
        html(res, setupHtml(token));
        return;
      }
      if (req.method === 'GET' && (url.pathname === '/assets/brand/logo.png' || url.pathname === '/assets/brand/logo-background.png')) {
        const name = url.pathname.endsWith('logo-background.png') ? 'logo-background.png' : 'logo.png';
        const file = path.join(repoRoot, 'assets', 'brand', name);
        const data = await fs.readFile(file);
        res.writeHead(200, {
          'content-type': 'image/png',
          'content-length': data.byteLength,
          'cache-control': 'public, max-age=3600',
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer'
        });
        res.end(data);
        return;
      }
      if (req.headers['x-rwmcp-setup-token'] !== token) {
        json(res, 403, { error: 'Invalid or missing setup token.' });
        return;
      }

      if (url.pathname === '/api/status' && req.method === 'GET') {
        const settingsFileExists = await pathExists(setupSettingsPath());
        let settings = await loadEffectiveSetupSettings(repoRoot);
        const configuredPortFree = await portAvailable(settings.mcpPort);
        let configuredPortOwnedByManagedRuntime = false;
        if (!configuredPortFree) {
          const runtime = await safeRuntimeStatus(repoRoot) as { running?: boolean; port?: number };
          configuredPortOwnedByManagedRuntime = runtime.running === true && runtime.port === settings.mcpPort;
        }
        const configuredPortAvailable = configuredPortFree || configuredPortOwnedByManagedRuntime;
        const recommendedPort = configuredPortAvailable ? settings.mcpPort : await recommendedMcpPort(settings.mcpPort);
        if (!settingsFileExists && recommendedPort !== settings.mcpPort) {
          settings = { ...settings, mcpPort: recommendedPort };
        }
        const packageJson = JSON.parse(await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8')) as { version: string };
        const identity = await loadOrCreateDeviceIdentity();
        const tunnelClient = tunnelClientPath(repoRoot);
        json(res, 200, {
          version: packageJson.version,
          identity,
          recommendedAppName: recommendedChatGptAppName(identity),
          platform: process.platform,
          nodeVersion: process.version,
          settings,
          settingsPersisted: settingsFileExists,
          settingsPath: setupSettingsPath(),
          runtimeApiKeyStored: await runtimeKeyStored(repoRoot),
          onboardingRequired: !settings.tunnelId || !(await runtimeKeyStored(repoRoot)),
          tunnelClientInstalled: await pathExists(tunnelClient),
          workspaceExists: await directoryExists(settings.workspaceRoot),
          configuredPortAvailable,
          configuredPortFree,
          configuredPortOwnedByManagedRuntime,
          recommendedMcpPort: recommendedPort
        });
        return;
      }

      if (url.pathname === '/api/recovery/status' && req.method === 'GET') {
        const settings = await loadEffectiveSetupSettings(repoRoot);
        const packageJson = JSON.parse(await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8')) as { version: string };
        const identity = await loadOrCreateDeviceIdentity();
        const tunnelClient = tunnelClientPath(repoRoot);
        json(res, 200, {
          version: packageJson.version,
          identity,
          recommendedAppName: recommendedChatGptAppName(identity),
          settings,
          settingsPersisted: await pathExists(setupSettingsPath()),
          runtimeApiKeyStored: await runtimeKeyStored(repoRoot),
          onboardingRequired: !settings.tunnelId || !(await runtimeKeyStored(repoRoot)),
          tunnelClientInstalled: await pathExists(tunnelClient),
          workspaceExists: await directoryExists(settings.workspaceRoot),
          configuredPortAvailable: true,
          configuredPortFree: await portAvailable(settings.mcpPort),
          configuredPortOwnedByManagedRuntime: false,
          recommendedMcpPort: settings.mcpPort,
          recoveryMode: true,
          localControlCenter: 'ONLINE'
        });
        return;
      }

      if (url.pathname === '/api/bootstrap' && req.method === 'POST') {
        const body = await readJsonBody(req) as { tunnelId?: string; runtimeApiKey?: string };
        if (!body.tunnelId?.trim()) throw new Error('Tunnel ID is required.');
        if (!body.runtimeApiKey?.trim()) throw new Error('Runtime API key is required.');
        json(res, 200, await bootstrapWorkstation(repoRoot, body.tunnelId, body.runtimeApiKey));
        return;
      }
      if (url.pathname === '/api/recovery/test' && req.method === 'POST') {
        const body = await readJsonBody(req) as { tunnelId?: string; runtimeApiKey?: string };
        const currentSettings = await loadEffectiveSetupSettings(repoRoot);
        const tunnelId = (body.tunnelId ?? currentSettings.tunnelId).trim();
        json(res, 200, await testOpenAiTunnel(repoRoot, tunnelId, body.runtimeApiKey));
        return;
      }

      if (url.pathname === '/api/recovery/apply' && req.method === 'POST') {
        const body = await readJsonBody(req) as { tunnelId?: string; organizationId?: string; runtimeApiKey?: string; reconnect?: boolean };
        const currentSettings = await loadEffectiveSetupSettings(repoRoot);
        const settings = normalizeSetupSettings({
          ...currentSettings,
          tunnelId: body.tunnelId ?? currentSettings.tunnelId,
          organizationId: body.organizationId ?? currentSettings.organizationId
        });
        await saveSetupSettings(settings);
        if (body.runtimeApiKey?.trim()) await storeRuntimeKey(repoRoot, body.runtimeApiKey.trim());
        await syncLinuxDirectNodeSettings(settings);
        const reconnect = body.reconnect !== false;
        const restart = reconnect
          ? (process.platform === 'win32'
              ? await scheduleWindowsRuntimeRestart(repoRoot, 'OpenAI')
              : await linuxRuntimeControl(repoRoot, 'Restart', 'OpenAI'))
          : null;
        json(res, 200, {
          ok: true,
          settings,
          runtimeApiKeyStored: await runtimeKeyStored(repoRoot),
          reconnectAccepted: reconnect && restart !== null,
          restart
        });
        return;
      }

      if (url.pathname === '/api/devices/pairing' && req.method === 'GET') {
        const hosts = await loadHosts();
        const pairing = new PairingStore();
        json(res, 200, {
          devices: await pairing.listDevices(),
          pending: await pairing.listPending(),
          bootstrapHosts: hosts.hosts.map(host => ({ id: host.id, name: host.name ?? host.id, hostname: host.hostname, platform: 'ssh' }))
        });
        return;
      }

      if (url.pathname === '/api/devices/pairing-code' && req.method === 'POST') {
        const body = await readJsonBody(req) as { requestedName?: string; bootstrapHostId?: string; ttlSeconds?: number };
        const pairing = new PairingStore();
        json(res, 200, await pairing.createCode({
          requestedName: body.requestedName,
          bootstrapHostId: body.bootstrapHostId,
          ttlSeconds: body.ttlSeconds
        }));
        return;
      }

      if (url.pathname === '/api/devices/bootstrap-ssh' && req.method === 'POST') {
        const body = await readJsonBody(req) as { hostId?: string; code?: string; name?: string };
        if (!body.hostId || !body.code) throw new Error('hostId and pairing code are required.');
        const packageJson = JSON.parse(await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8')) as { version: string };
        const hosts = await loadHosts();
        const pairing = new PairingStore();
        const bootstrap = new PairingBootstrapAdapter(hosts, pairing, packageJson.version);
        json(res, 200, await bootstrap.bootstrapSsh({ hostId: body.hostId, code: body.code, name: body.name }));
        return;
      }

      const revokeDevice = url.pathname.match(/^\/api\/devices\/([A-Za-z0-9._-]+)\/revoke$/);
      if (revokeDevice && req.method === 'POST') {
        const pairing = new PairingStore();
        json(res, 200, await pairing.revoke(revokeDevice[1]!));
        return;
      }
      if (url.pathname === '/api/update/status' && req.method === 'GET') {
        json(res, 200, await updateControl(repoRoot, 'Status'));
        return;
      }

      if (url.pathname === '/api/update/check' && req.method === 'POST') {
        json(res, 200, await updateControl(repoRoot, 'Check'));
        return;
      }

      if (url.pathname === '/api/update/config' && req.method === 'POST') {
        const body = await readJsonBody(req) as { enabled?: boolean };
        if (typeof body.enabled !== 'boolean') throw new Error('enabled must be a boolean.');
        json(res, 200, await updateControl(repoRoot, body.enabled ? 'Enable' : 'Disable'));
        return;
      }

      if (url.pathname === '/api/update/install' && req.method === 'POST') {
        const result = await updateControl(repoRoot, 'Install') as Record<string, unknown>;
        const accepted = result.accepted === true;
        json(res, accepted ? 202 : 200, result);
        return;
      }

      if (url.pathname === '/api/admin/requests' && req.method === 'GET') {
        const requests = await listAdminRequests();
        json(res, 200, { requests: requests.slice(0, 20) });
        return;
      }

      const adminAction = url.pathname.match(/^\/api\/admin\/requests\/([0-9a-fA-F-]+)\/(approve|deny)$/);
      if (adminAction && req.method === 'POST') {
        const [, requestId, action] = adminAction;
        if (action === 'deny') {
          json(res, 200, await denyAdminRequest(requestId!));
          return;
        }
        if (process.platform !== 'win32') throw new Error('Administrator approval helper currently supports Windows only.');
        const body = await readJsonBody(req) as { expectedCommandHash?: string };
        if (!body.expectedCommandHash) throw new Error('expectedCommandHash is required for Administrator approval.');
        const approved = await approveAdminRequest(requestId!, body.expectedCommandHash);
        const launcher = path.join(repoRoot, 'scripts', 'admin-approval-windows.ps1');
        const child = spawn('powershell.exe', [
          '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launcher,
          '-RequestPath', approved.file,
          '-ExpectedSha256', approved.fileSha256,
          '-Root', repoRoot
        ], { cwd: repoRoot, detached: true, stdio: 'ignore', windowsHide: true });
        child.unref();
        json(res, 202, { requestId: approved.request.id, state: approved.request.state, uacPrompted: true });
        return;
      }

      if (url.pathname === '/api/quality/settings' && req.method === 'GET') {
        json(res, 200, {
          settings: await new QualityLearningSettingsStore().load(),
          authority: 'owner-local-only',
          canonicalProjectDataUnaffected: true
        });
        return;
      }

      if (url.pathname === '/api/quality/settings' && req.method === 'POST') {
        const body = await readJsonBody(req) as {
          enabled?: boolean;
          retentionDays?: number;
          maxObservations?: number;
          minApprovedSamples?: number;
          minScore?: number;
        };
        const settings = await new QualityLearningSettingsStore().update(body);
        const retention = await new QualityObservationStore('local-owner').applyRetentionForOwnerLearning();
        json(res, 200, {
          settings,
          retention,
          authority: 'owner-local-only',
          restartRequired: false
        });
        return;
      }

      if (url.pathname === '/api/quality/knowledge' && req.method === 'GET') {
        json(res, 200, {
          records: await new QualityKnowledgeStore().list(200),
          authority: 'owner-local-only',
          recommendationOnly: true,
          executionActivationEnabled: false,
          mcpPromotionEnabled: false
        });
        return;
      }

      if (url.pathname === '/api/quality/knowledge/draft' && req.method === 'POST') {
        const body = await readJsonBody(req) as {
          workspace?: string;
          projectPath?: string;
          workflow?: string;
        };
        if (!body.workspace?.trim() || !body.projectPath?.trim() || !body.workflow?.trim()) {
          throw new Error('workspace, projectPath and workflow are required.');
        }
        const record = await new QualityKnowledgeStore().createDraft(
          body.workspace.trim(),
          body.projectPath.trim(),
          body.workflow.trim()
        );
        json(res, 200, {
          record,
          authority: 'owner-local-only',
          recommendationOnly: true,
          executionActive: false
        });
        return;
      }

      const qualityKnowledgeAction = url.pathname.match(
        /^\/api\/quality\/knowledge\/([0-9a-fA-F-]+)\/(shadow|promote|revalidate|revoke)$/
      );
      if (qualityKnowledgeAction && req.method === 'POST') {
        const [, recordId, action] = qualityKnowledgeAction;
        const body = await readJsonBody(req) as { reason?: string };
        const knowledge = new QualityKnowledgeStore();
        const record = action === 'shadow'
          ? await knowledge.evaluateShadowAgainstApprovedEvidence(recordId!)
          : action === 'promote'
            ? await knowledge.promote(recordId!, body.reason)
            : action === 'revalidate'
              ? await knowledge.revalidateAgainstApprovedEvidence(recordId!)
              : await knowledge.revoke(recordId!, body.reason);
        json(res, 200, {
          record,
          authority: 'owner-local-only',
          recommendationOnly: true,
          executionActive: false
        });
        return;
      }

      if (url.pathname === '/api/quality/history' && req.method === 'DELETE') {
        const observations = new QualityObservationStore('local-owner');
        const reviews = new OwnerQualityReviewStore();
        const knowledge = new QualityKnowledgeStore();
        const [observationCount, decisionCount, knowledgeCount] = await Promise.all([
          observations.clearForOwnerLearning(),
          reviews.clearForOwner(),
          knowledge.clearForOwner()
        ]);
        json(res, 200, {
          cleared: {
            observations: observationCount,
            ownerDecisions: decisionCount,
            reusableKnowledgeRecords: knowledgeCount
          },
          canonicalProjectDataUnaffected: true,
          authority: 'owner-local-only'
        });
        return;
      }

      if (url.pathname === '/api/quality/review' && req.method === 'GET') {
        const observations = await new QualityObservationStore('local-owner').listForOwnerReview(100);
        const decisions = await new OwnerQualityReviewStore().list(500);
        const latestByObservation = new Map<string, (typeof decisions)[number]>();
        for (const decision of decisions) {
          if (!latestByObservation.has(decision.observationId)) {
            latestByObservation.set(decision.observationId, decision);
          }
        }
        json(res, 200, {
          items: observations.map(observation => ({
            observation,
            ownerDecision: latestByObservation.get(observation.id) ?? null
          })),
          authority: 'owner-local-only',
          promotionEnabled: false,
          activationEnabled: false
        });
        return;
      }

      const qualityReviewAction = url.pathname.match(
        /^\/api\/quality\/review\/([0-9a-fA-F-]+)\/(approve|reject|revoke)$/
      );
      if (qualityReviewAction && req.method === 'POST') {
        const [, observationId, action] = qualityReviewAction;
        const body = await readJsonBody(req) as { reason?: string };
        const observations = new QualityObservationStore('local-owner');
        const observation = await observations.getForOwnerReview(observationId!);
        if (!observation) {
          json(res, 404, { error: 'Pending quality observation was not found.' });
          return;
        }
        const decisionMap: Record<'approve' | 'reject' | 'revoke', OwnerQualityDecisionKind> = {
          approve: 'approved',
          reject: 'rejected',
          revoke: 'revoked'
        };
        const decision = await new OwnerQualityReviewStore().decide(
          observation,
          decisionMap[action as 'approve' | 'reject' | 'revoke'],
          body.reason
        );
        json(res, 200, {
          observationId: observation.id,
          decision,
          promotionState: 'not-promoted',
          active: false
        });
        return;
      }

      if (url.pathname === '/api/permissions' && req.method === 'GET') {
        json(res, 200, await readPermissionState(repoRoot));
        return;
      }

      if (url.pathname === '/api/permissions/mode' && req.method === 'POST') {
        const body = await readJsonBody(req) as { mode?: string };
        const allowed = new Set(['read_only', 'workspace', 'full_control']);
        if (!body.mode || !allowed.has(body.mode)) throw new Error('Unsupported permission mode.');
        const state = await applyOwnerPermissionMode(repoRoot, body.mode as 'read_only' | 'workspace' | 'full_control');
        process.env.RWMCP_HTTP_SCOPES = state.httpScopes.join(',');
        if (process.platform !== 'win32') await updateEnvFile(linuxOpenAiEnvPath(), { RWMCP_HTTP_SCOPES: state.httpScopes.join(',') });
        json(res, 200, { ...state, restartRequired: true });
        return;
      }

      if (url.pathname === '/api/permissions/config' && req.method === 'POST') {
        const body = await readJsonBody(req) as {
          httpScopes?: string[];
          allowHostFilesystem?: boolean;
          allowRawShell?: boolean;
        };
        if (!Array.isArray(body.httpScopes)) throw new Error('httpScopes must be an array.');
        const state = await applyPermissionConfig(repoRoot, {
          httpScopes: body.httpScopes,
          allowHostFilesystem: body.allowHostFilesystem === true,
          allowRawShell: body.allowRawShell === true
        });
        // Runtime actions are launched as children of this persistent Control Center.
        // Refresh the inherited scope environment immediately so a following Restart
        // uses the just-saved owner choice instead of the scope snapshot from startup.
        process.env.RWMCP_HTTP_SCOPES = state.httpScopes.join(',');
        if (process.platform !== 'win32') await updateEnvFile(linuxOpenAiEnvPath(), { RWMCP_HTTP_SCOPES: state.httpScopes.join(',') });
        json(res, 200, { ...state, restartRequired: true });
        return;
      }

      if (url.pathname === '/api/permissions/lease' && req.method === 'POST') {
        const body = await readJsonBody(req) as { ttlMinutes?: number };
        const state = await readPermissionState(repoRoot);
        if (!state.httpScopes.includes('workstation.full_control')) {
          throw new Error('Enable and apply workstation.full_control before issuing a full-control lease.');
        }
        if (!state.allowHostFilesystem && !state.allowRawShell) {
          throw new Error('Enable and apply at least one local full-control gate before issuing a lease.');
        }
        const lease = await grantFullControlLease(Number(body.ttlMinutes), 'openai-tunnel');
        json(res, 200, { lease, restartRequired: true });
        return;
      }

      if (url.pathname === '/api/permissions/lease' && req.method === 'DELETE') {
        await revokePermissionLease();
        json(res, 200, { ok: true, restartRequired: true });
        return;
      }

      if (url.pathname === '/api/runtime/status' && req.method === 'GET') {
        json(res, 200, await safeRuntimeStatus(repoRoot));
        return;
      }

      if (url.pathname === '/api/runtime/action' && req.method === 'POST') {
        const body = await readJsonBody(req) as { action?: string; mode?: string };
        const actions = new Set<RuntimeAction>(['Start', 'Stop', 'Restart', 'RegisterStartup', 'UnregisterStartup']);
        if (!body.action || !actions.has(body.action as RuntimeAction)) throw new Error('Unsupported runtime action.');
        const mode: RuntimeMode = body.mode === 'Local' ? 'Local' : 'OpenAI';
        if (body.action === 'Restart' && process.platform === 'win32') {
          json(res, 202, await scheduleWindowsRuntimeRestart(repoRoot, mode));
          return;
        }
        json(res, 200, await runtimeControl(repoRoot, body.action as RuntimeAction, mode));
        return;
      }

      if (url.pathname === '/api/save' && req.method === 'POST') {
        const body = await readJsonBody(req) as Partial<SetupSaveRequest>;
        const currentSettings = await loadEffectiveSetupSettings(repoRoot);
        const settings = normalizeSetupSettings({
          ...currentSettings,
          version: 1,
          mcpPort: body.mcpPort,
          workspaceRoot: body.workspaceRoot,
          tunnelId: body.tunnelId ?? '',
          organizationId: body.organizationId ?? '',
          cloudflaredManaged: body.cloudflaredManaged ?? false,
          controlPort: body.controlPort ?? currentSettings.controlPort,
          httpScopes: body.httpScopes ?? currentSettings.httpScopes
        });
        const mcpPortFree = await portAvailable(settings.mcpPort);
        let managedRuntimeOwnsPort = false;
        if (!mcpPortFree) {
          const runtime = await runtimeControl(repoRoot, 'Status') as { running?: boolean; port?: number };
          managedRuntimeOwnsPort = runtime.running === true && runtime.port === settings.mcpPort;
        }
        if (!mcpPortFree && !managedRuntimeOwnsPort) {
          throw new Error(`MCP port ${settings.mcpPort} is already in use by another process. Stop it or choose another loopback port before saving.`);
        }
        if (settings.controlPort !== boundPort && !(await portAvailable(settings.controlPort))) {
          throw new Error(`Control Center port ${settings.controlPort} is already in use. Choose another loopback port before saving.`);
        }
        await fs.mkdir(settings.workspaceRoot, { recursive: true });
        const settingsPath = await saveSetupSettings(settings);
        await syncLinuxDirectNodeSettings(settings);
        const policy = await ensureDefaultPolicy(repoRoot, settings.workspaceRoot);
        const hosts = await ensureHostsConfig(repoRoot);
        if (body.runtimeApiKey) {
          if (body.storeRuntimeApiKey === false) {
            throw new Error('A supplied runtime API key must either be stored securely or omitted. Session-only keys should be set in the terminal environment instead of the setup form.');
          }
          await storeRuntimeKey(repoRoot, body.runtimeApiKey);
        }
        json(res, 200, {
          ok: true,
          message: `${settingsPath}; ${policy.created ? 'created default policy' : 'existing policy preserved'} at ${policy.path}; ${hosts.created ? 'created hosts config' : 'existing hosts config preserved'} at ${hosts.path}.`,
          runtimeApiKeyStored: await runtimeKeyStored(repoRoot)
        });
        return;
      }

      if (url.pathname === '/api/runtime-key' && req.method === 'DELETE') {
        await removeRuntimeKey(repoRoot);
        json(res, 200, { ok: true });
        return;
      }

      if (url.pathname === '/api/install-tunnel-client' && req.method === 'POST') {
        json(res, 200, { ok: true, output: await installTunnelClient(repoRoot) });
        return;
      }

      json(res, 404, { error: 'Not found.' });
    } catch (error) {
      json(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  boundPort = await listen(server, preferredPort, options.strictPort === true);
  const url = `http://127.0.0.1:${boundPort}/`;
  console.error(`[remote-workstation-mcp] Setup & Control Center: ${url}`);
  console.error('[remote-workstation-mcp] Local-only CSRF token is ephemeral, embedded into the served page, and is not written to disk.');
  if (options.openBrowser !== false) await openBrowser(url);

  return {
    url,
    port: boundPort,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  };
}
