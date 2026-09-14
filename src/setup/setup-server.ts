import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { setupHtml } from './ui.js';
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
}

interface SetupSaveRequest extends SetupSettings {
  runtimeApiKey?: string;
  storeRuntimeApiKey?: boolean;
}

const MAX_BODY_BYTES = 64 * 1024;
const MCP_PORT_CANDIDATES = [8765, 8683, 8877, 9876, 18765, 19001, 20080];

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

function runProcess(program: string, args: string[], options: { cwd: string; stdin?: string; maxBytes?: number }): Promise<{ code: number; output: string }> {
  const maxBytes = options.maxBytes ?? 128 * 1024;
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let output = '';
    const append = (chunk: Buffer | string) => {
      if (Buffer.byteLength(output) >= maxBytes) return;
      output += chunk.toString();
      if (Buffer.byteLength(output) > maxBytes) output = output.slice(0, maxBytes);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.once('error', reject);
    child.once('close', code => resolve({ code: code ?? -1, output: output.trim() }));
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

async function listen(server: http.Server, preferredPort: number): Promise<number> {
  const candidates = Array.from({ length: 20 }, (_, index) => preferredPort + index).filter(port => port <= 65535);
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
        html(res, setupHtml());
        return;
      }
      if (req.headers['x-rwmcp-setup-token'] !== token) {
        json(res, 403, { error: 'Invalid or missing setup token.' });
        return;
      }

      if (url.pathname === '/api/status' && req.method === 'GET') {
        const settingsFileExists = await pathExists(setupSettingsPath());
        let settings = await loadSetupSettings();
        const configuredPortAvailable = await portAvailable(settings.mcpPort);
        const recommendedPort = configuredPortAvailable ? settings.mcpPort : await recommendedMcpPort(settings.mcpPort);
        if (!settingsFileExists && recommendedPort !== settings.mcpPort) {
          settings = { ...settings, mcpPort: recommendedPort };
        }
        const packageJson = JSON.parse(await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8')) as { version: string };
        const tunnelClient = process.platform === 'win32'
          ? path.join(repoRoot, 'runtime', 'openai-tunnel', 'tunnel-client.exe')
          : path.join(repoRoot, 'runtime', 'openai-tunnel', 'tunnel-client');
        json(res, 200, {
          version: packageJson.version,
          platform: process.platform,
          nodeVersion: process.version,
          settings,
          settingsPersisted: settingsFileExists,
          settingsPath: setupSettingsPath(),
          runtimeApiKeyStored: await pathExists(setupSecretPath()),
          tunnelClientInstalled: await pathExists(tunnelClient),
          workspaceExists: await directoryExists(settings.workspaceRoot),
          configuredPortAvailable,
          recommendedMcpPort: recommendedPort
        });
        return;
      }

      if (url.pathname === '/api/save' && req.method === 'POST') {
        const body = await readJsonBody(req) as Partial<SetupSaveRequest>;
        const settings = normalizeSetupSettings({
          version: 1,
          mcpPort: body.mcpPort,
          workspaceRoot: body.workspaceRoot,
          tunnelId: body.tunnelId ?? '',
          organizationId: body.organizationId ?? '',
          cloudflaredManaged: body.cloudflaredManaged ?? false
        });
        if (!(await portAvailable(settings.mcpPort))) {
          throw new Error(`MCP port ${settings.mcpPort} is already in use. Choose another loopback port.`);
        }
        await fs.mkdir(settings.workspaceRoot, { recursive: true });
        const settingsPath = await saveSetupSettings(settings);
        const policy = await ensureDefaultPolicy(repoRoot, settings.workspaceRoot);
        await ensureHostsConfig(repoRoot);
        if (body.runtimeApiKey) {
          if (body.storeRuntimeApiKey === false) {
            throw new Error('A supplied runtime API key must either be stored securely or omitted. Session-only keys should be set in the terminal environment instead of the setup form.');
          }
          await storeWindowsRuntimeKey(repoRoot, body.runtimeApiKey);
        }
        json(res, 200, {
          ok: true,
          message: `${settingsPath}; ${policy.created ? 'created default policy' : 'existing policy preserved'}.`,
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
        if (process.platform !== 'win32') {
          json(res, 400, { error: 'The bundled tunnel-client installer currently supports Windows only.' });
          return;
        }
        const installer = path.join(repoRoot, 'scripts', 'install-openai-tunnel-windows.ps1');
        const result = await runProcess('powershell.exe', [
          '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', installer
        ], { cwd: repoRoot, maxBytes: 256 * 1024 });
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

  boundPort = await listen(server, preferredPort);
  const url = `http://127.0.0.1:${boundPort}/#token=${encodeURIComponent(token)}`;
  console.error(`[remote-workstation-mcp] Setup Console: ${url}`);
  console.error('[remote-workstation-mcp] Local-only setup token is ephemeral and is not written to disk.');
  if (options.openBrowser !== false) await openBrowser(url);

  return {
    url,
    port: boundPort,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  };
}
