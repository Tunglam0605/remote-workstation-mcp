import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { setupHtml } from './ui.js';
import { loadOrCreateDeviceIdentity, recommendedChatGptAppName } from '../device-identity.js';
import { loadHosts } from '../hosts.js';
import { PairingStore } from '../pairing/pairing-store.js';
import { PairingBootstrapAdapter } from '../pairing/pairing-bootstrap.js';
import { approveAdminRequest, denyAdminRequest, listAdminRequests } from '../privileged/approval-store.js';
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

async function testOpenAiTunnel(repoRoot: string, tunnelId: string, runtimeApiKey?: string): Promise<{ ok: boolean; tunnelId: string; message: string }> {
  if (!/^tunnel_[0-9a-f]{32}$/.test(tunnelId)) {
    return { ok: false, tunnelId, message: "Tunnel ID must match 'tunnel_' followed by 32 lowercase hexadecimal characters." };
  }
  const tunnelClient = process.platform === 'win32'
    ? path.join(repoRoot, 'runtime', 'openai-tunnel', 'tunnel-client.exe')
    : path.join(repoRoot, 'runtime', 'openai-tunnel', 'tunnel-client');
  if (!(await pathExists(tunnelClient))) {
    return { ok: false, tunnelId, message: 'OpenAI tunnel-client is not installed in this runtime slot.' };
  }
  const key = runtimeApiKey?.trim() || await readWindowsRuntimeKey(repoRoot);
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

function scheduleWindowsRuntimeRestart(repoRoot: string, mode: RuntimeMode = 'OpenAI'): { accepted: true; action: 'Restart'; mode: RuntimeMode } {
  if (process.platform !== 'win32') {
    throw new Error('Windows runtime restart handoff is available on Windows only.');
  }
  const script = path.join(repoRoot, 'scripts', 'runtime-restart-handoff-windows.ps1');
  const child = spawn('powershell.exe', [
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-Root', repoRoot, '-Mode', mode
  ], {
    cwd: repoRoot,
    shell: false,
    windowsHide: true,
    detached: true,
    stdio: 'ignore'
  });
  child.unref();
  return { accepted: true, action: 'Restart', mode };
}

async function windowsUpdateControl(repoRoot: string, action: 'Status' | 'Check' | 'Enable' | 'Disable'): Promise<unknown> {
  if (process.platform !== 'win32') {
    return { supported: false, enabled: false, message: 'Windows update control is available on Windows only.' };
  }
  const script = path.join(repoRoot, 'scripts', 'update-windows.ps1');
  if (!(await pathExists(script))) {
    return { supported: false, enabled: false, message: 'Windows update helper is not installed in this runtime.' };
  }
  const result = await runProcess('powershell.exe', [
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-Action', action,
    '-Json'
  ], { cwd: repoRoot, maxBytes: 128 * 1024, timeoutMs: 15000 });
  if (result.code !== 0) throw new Error(result.output || `Windows update action '${action}' failed with exit code ${result.code}.`);
  return parseJsonOutput(result.output);
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
        let settings = await loadSetupSettings();
        const configuredPortFree = await portAvailable(settings.mcpPort);
        let configuredPortOwnedByManagedRuntime = false;
        if (!configuredPortFree && process.platform === 'win32') {
          const runtime = await safeWindowsRuntimeStatus(repoRoot) as { running?: boolean; port?: number };
          configuredPortOwnedByManagedRuntime = runtime.running === true && runtime.port === settings.mcpPort;
        }
        const configuredPortAvailable = configuredPortFree || configuredPortOwnedByManagedRuntime;
        const recommendedPort = configuredPortAvailable ? settings.mcpPort : await recommendedMcpPort(settings.mcpPort);
        if (!settingsFileExists && recommendedPort !== settings.mcpPort) {
          settings = { ...settings, mcpPort: recommendedPort };
        }
        const packageJson = JSON.parse(await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8')) as { version: string };
        const identity = await loadOrCreateDeviceIdentity();
        const tunnelClient = process.platform === 'win32'
          ? path.join(repoRoot, 'runtime', 'openai-tunnel', 'tunnel-client.exe')
          : path.join(repoRoot, 'runtime', 'openai-tunnel', 'tunnel-client');
        json(res, 200, {
          version: packageJson.version,
          identity,
          recommendedAppName: recommendedChatGptAppName(identity),
          platform: process.platform,
          nodeVersion: process.version,
          settings,
          settingsPersisted: settingsFileExists,
          settingsPath: setupSettingsPath(),
          runtimeApiKeyStored: await pathExists(setupSecretPath()),
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
        const settings = await loadSetupSettings();
        const packageJson = JSON.parse(await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8')) as { version: string };
        const identity = await loadOrCreateDeviceIdentity();
        const tunnelClient = process.platform === 'win32'
          ? path.join(repoRoot, 'runtime', 'openai-tunnel', 'tunnel-client.exe')
          : path.join(repoRoot, 'runtime', 'openai-tunnel', 'tunnel-client');
        json(res, 200, {
          version: packageJson.version,
          identity,
          recommendedAppName: recommendedChatGptAppName(identity),
          settings,
          settingsPersisted: await pathExists(setupSettingsPath()),
          runtimeApiKeyStored: await pathExists(setupSecretPath()),
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

      if (url.pathname === '/api/recovery/test' && req.method === 'POST') {
        const body = await readJsonBody(req) as { tunnelId?: string; runtimeApiKey?: string };
        const currentSettings = await loadSetupSettings();
        const tunnelId = (body.tunnelId ?? currentSettings.tunnelId).trim();
        json(res, 200, await testOpenAiTunnel(repoRoot, tunnelId, body.runtimeApiKey));
        return;
      }

      if (url.pathname === '/api/recovery/apply' && req.method === 'POST') {
        const body = await readJsonBody(req) as { tunnelId?: string; organizationId?: string; runtimeApiKey?: string; reconnect?: boolean };
        const currentSettings = await loadSetupSettings();
        const settings = normalizeSetupSettings({
          ...currentSettings,
          tunnelId: body.tunnelId ?? currentSettings.tunnelId,
          organizationId: body.organizationId ?? currentSettings.organizationId
        });
        await saveSetupSettings(settings);
        if (body.runtimeApiKey?.trim()) await storeWindowsRuntimeKey(repoRoot, body.runtimeApiKey.trim());
        const reconnect = body.reconnect !== false;
        const restart = reconnect && process.platform === 'win32'
          ? scheduleWindowsRuntimeRestart(repoRoot, 'OpenAI')
          : null;
        json(res, 200, {
          ok: true,
          settings,
          runtimeApiKeyStored: await pathExists(setupSecretPath()),
          reconnectAccepted: restart?.accepted === true,
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
        json(res, 200, await windowsUpdateControl(repoRoot, 'Status'));
        return;
      }

      if (url.pathname === '/api/update/check' && req.method === 'POST') {
        json(res, 200, await windowsUpdateControl(repoRoot, 'Check'));
        return;
      }

      if (url.pathname === '/api/update/config' && req.method === 'POST') {
        const body = await readJsonBody(req) as { enabled?: boolean };
        if (typeof body.enabled !== 'boolean') throw new Error('enabled must be a boolean.');
        json(res, 200, await windowsUpdateControl(repoRoot, body.enabled ? 'Enable' : 'Disable'));
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
        json(res, 200, await safeWindowsRuntimeStatus(repoRoot));
        return;
      }

      if (url.pathname === '/api/runtime/action' && req.method === 'POST') {
        const body = await readJsonBody(req) as { action?: string; mode?: string };
        const actions = new Set<RuntimeAction>(['Start', 'Stop', 'Restart', 'RegisterStartup', 'UnregisterStartup']);
        if (!body.action || !actions.has(body.action as RuntimeAction)) throw new Error('Unsupported runtime action.');
        const mode: RuntimeMode = body.mode === 'Local' ? 'Local' : 'OpenAI';
        if (body.action === 'Restart') {
          json(res, 202, scheduleWindowsRuntimeRestart(repoRoot, mode));
          return;
        }
        json(res, 200, await windowsRuntimeControl(repoRoot, body.action as RuntimeAction, mode));
        return;
      }

      if (url.pathname === '/api/save' && req.method === 'POST') {
        const body = await readJsonBody(req) as Partial<SetupSaveRequest>;
        const currentSettings = await loadSetupSettings();
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
        if (!mcpPortFree && process.platform === 'win32') {
          const runtime = await windowsRuntimeControl(repoRoot, 'Status') as { running?: boolean; port?: number };
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
        const policy = await ensureDefaultPolicy(repoRoot, settings.workspaceRoot);
        const hosts = await ensureHostsConfig(repoRoot);
        if (body.runtimeApiKey) {
          if (body.storeRuntimeApiKey === false) {
            throw new Error('A supplied runtime API key must either be stored securely or omitted. Session-only keys should be set in the terminal environment instead of the setup form.');
          }
          await storeWindowsRuntimeKey(repoRoot, body.runtimeApiKey);
        }
        json(res, 200, {
          ok: true,
          message: `${settingsPath}; ${policy.created ? 'created default policy' : 'existing policy preserved'} at ${policy.path}; ${hosts.created ? 'created hosts config' : 'existing hosts config preserved'} at ${hosts.path}.`,
          runtimeApiKeyStored: await pathExists(setupSecretPath())
        });
        return;
      }

      if (url.pathname === '/api/runtime-key' && req.method === 'DELETE') {
        await removeWindowsRuntimeKey(repoRoot);
        json(res, 200, { ok: true });
        return;
      }

      if (url.pathname === '/api/install-tunnel-client' && req.method === 'POST') {
        const result = process.platform === 'win32'
          ? await runProcess('powershell.exe', [
              '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(repoRoot, 'scripts', 'install-openai-tunnel-windows.ps1')
            ], { cwd: repoRoot, maxBytes: 256 * 1024 })
          : await runProcess('bash', [path.join(repoRoot, 'scripts', 'install-openai-tunnel-linux.sh')], { cwd: repoRoot, maxBytes: 256 * 1024 });
        if (result.code !== 0) {
          json(res, 500, { error: result.output || `Installer exited with code ${result.code}.` });
          return;
        }
        json(res, 200, { ok: true, output: result.output });
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
