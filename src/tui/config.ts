import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import YAML from 'yaml';
import { deviceIdentityPath, loadOrCreateDeviceIdentity } from '../device-identity.js';
import { NodeInterlockStore } from '../node-interlock.js';
import { applyOwnerPermissionMode, readPermissionState, type OwnerPermissionMode } from '../setup/permissions.js';
import { loadSetupSettings, saveSetupSettings, setupConfigDir, setupSecretPath } from '../setup/settings.js';

export interface TuiRuntimeState {
  platform: NodeJS.Platform;
  deviceName: string;
  tunnelId: string;
  mcpPort: number;
  accessMode: string;
  httpScopes: string[];
  service: string;
  tunnelReady: boolean | null;
  workspaceLabel: string;
  workspaceRoot: string;
  runtimeKeyConfigured: boolean;
}

export interface TuiConfigOptions {
  platform?: NodeJS.Platform;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}

function platformOf(options: TuiConfigOptions): NodeJS.Platform {
  return options.platform ?? process.platform;
}

function homeOf(options: TuiConfigOptions): string {
  return options.homeDir ?? os.homedir();
}

function envOf(options: TuiConfigOptions): NodeJS.ProcessEnv {
  return options.env ?? process.env;
}

function configureManagedEnvironment(options: TuiConfigOptions): void {
  const platform = platformOf(options);
  const home = homeOf(options);
  const env = envOf(options);
  const configBase = setupConfigDir({ platform, homeDir: home, env });
  const dataBase = platform === 'win32'
    ? configBase
    : path.resolve(env.RWMCP_HOME || path.join(home, '.local', 'share', 'remote-workstation-mcp'));
  const policy = platform === 'win32' ? path.join(configBase, 'config', 'policy.yaml') : path.join(configBase, 'policy.yaml');
  const hosts = platform === 'win32' ? path.join(configBase, 'config', 'hosts.yaml') : path.join(configBase, 'hosts.yaml');
  process.env.RWMCP_POLICY ??= policy;
  process.env.RWMCP_HOSTS ??= hosts;
  process.env.RWMCP_LEASE ??= path.join(dataBase, 'runtime', 'permission-lease.json');
  process.env.RWMCP_AUDIT ??= path.join(dataBase, 'runtime', 'audit.jsonl');
}

export function linuxOpenAiEnvPath(options: TuiConfigOptions = {}): string {
  return path.join(setupConfigDir({ platform: platformOf(options), homeDir: homeOf(options), env: envOf(options) }), 'openai.env');
}

function decodeEnvValue(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value.replace(/\\ /g, ' ').replace(/\\\\/g, '\\');
}

function encodeEnvValue(value: string): string {
  if (/^[A-Za-z0-9_./,:+@%=-]*$/.test(value)) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function parseEnvFile(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    values.set(key, decodeEnvValue(trimmed.slice(index + 1)));
  }
  return values;
}

export async function readEnvFile(file: string): Promise<Map<string, string>> {
  try {
    return parseEnvFile(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    throw error;
  }
}

export async function updateEnvFile(file: string, updates: Record<string, string | undefined>): Promise<void> {
  let original = '';
  try {
    original = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const pending = new Map(Object.entries(updates));
  const lines = original.split(/\r?\n/).filter((line, index, all) => !(index === all.length - 1 && line === ''));
  const output: string[] = [];
  for (const line of lines) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
    if (!match || !pending.has(match[1]!)) {
      output.push(line);
      continue;
    }
    const value = pending.get(match[1]!);
    pending.delete(match[1]!);
    if (value !== undefined) output.push(`${match[1]}=${encodeEnvValue(value)}`);
  }
  for (const [key, value] of pending) {
    if (value !== undefined) output.push(`${key}=${encodeEnvValue(value)}`);
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, `${output.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temp, file);
  if (process.platform !== 'win32') await fs.chmod(file, 0o600);
}

async function readWorkspace(repoRoot: string): Promise<{ label: string; root: string }> {
  const policyFile = path.resolve(process.env.RWMCP_POLICY?.trim() || path.join(repoRoot, 'config', 'policy.yaml'));
  try {
    const doc = YAML.parse(await fs.readFile(policyFile, 'utf8')) as { workspaces?: Array<{ name?: string; root?: string }> };
    const first = doc.workspaces?.[0];
    return { label: first?.name || 'Projects', root: first?.root || '-' };
  } catch {
    return { label: 'Projects', root: '-' };
  }
}

function run(command: string, args: string[], env?: NodeJS.ProcessEnv, input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: env ?? process.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', chunk => { stdout += String(chunk); });
    child.stderr?.on('data', chunk => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('close', code => resolve({ code: code ?? 1, stdout, stderr }));
    if (input !== undefined) child.stdin?.end(input); else child.stdin?.end();
  });
}

async function windowsRuntimeState(repoRoot: string): Promise<{ service: string; tunnelReady: boolean | null; port?: number }> {
  try {
    const launcher = process.env.RWMCP_WINDOWS_LAUNCHER?.trim() || path.resolve(repoRoot, '..', '..', 'bin', 'rwmcp.ps1');
    const result = await run('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launcher, '-Action', 'Status']);
    if (result.code !== 0) return { service: 'inactive', tunnelReady: false };
    const running = /running\s*:\s*True/i.test(result.stdout);
    const ready = /tunnelReady\s*:\s*True/i.test(result.stdout);
    const portMatch = /port\s*:\s*(\d+)/i.exec(result.stdout);
    return { service: running ? 'active' : 'inactive', tunnelReady: ready, ...(portMatch ? { port: Number(portMatch[1]) } : {}) };
  } catch {
    return { service: 'unknown', tunnelReady: null };
  }
}

function linuxSystemdEnv(options: TuiConfigOptions = {}): NodeJS.ProcessEnv {
  const env = { ...envOf(options) };
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  const runtimeDir = env.XDG_RUNTIME_DIR || (uid !== undefined ? `/run/user/${uid}` : undefined);
  if (runtimeDir) {
    env.XDG_RUNTIME_DIR = runtimeDir;
    env.DBUS_SESSION_BUS_ADDRESS ||= `unix:path=${runtimeDir}/bus`;
  }
  return env;
}

async function linuxServiceState(options: TuiConfigOptions = {}): Promise<string> {
  try {
    const env = linuxSystemdEnv(options);
    const result = await run('systemctl', ['--user', 'is-active', 'remote-workstation-mcp-openai.service'], env);
    if (result.code === 0) return result.stdout.trim() || 'active';
    const local = await run('systemctl', ['--user', 'is-active', 'remote-workstation-mcp.service'], env);
    return local.stdout.trim() || 'inactive';
  } catch {
    return 'unknown';
  }
}
async function linuxTunnelReady(options: TuiConfigOptions): Promise<boolean | null> {
  const root = envOf(options).RWMCP_HOME || path.join(homeOf(options), '.local', 'share', 'remote-workstation-mcp');
  try {
    const healthUrl = (await fs.readFile(path.join(root, 'runtime', 'openai-tunnel', 'health-url'), 'utf8')).trim();
    if (!healthUrl) return null;
    const response = await fetch(`${healthUrl.replace(/\/$/, '')}/readyz`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

export async function readTuiRuntimeState(repoRoot: string, options: TuiConfigOptions = {}): Promise<TuiRuntimeState> {
  configureManagedEnvironment(options);
  const platform = platformOf(options);
  const permission = await readPermissionState(repoRoot);
  const normalizedOptions = { platform, homeDir: homeOf(options), env: envOf(options) };
  const settings = await loadSetupSettings(normalizedOptions);
  const workspace = await readWorkspace(repoRoot);
  const identity = await loadOrCreateDeviceIdentity(normalizedOptions, envOf(options));
  let deviceName = identity.name;
  let tunnelId = settings.tunnelId;
  let mcpPort = settings.mcpPort;
  let runtimeKeyConfigured = false;
  let service = 'n/a';
  let tunnelReady: boolean | null = null;

  if (platform !== 'win32') {
    const envFile = await readEnvFile(linuxOpenAiEnvPath(options));
    deviceName = envFile.get('RWMCP_DEVICE_NAME') || deviceName;
    tunnelId = envFile.get('CONTROL_PLANE_TUNNEL_ID') || tunnelId;
    const envPort = Number(envFile.get('RWMCP_PORT'));
    if (Number.isInteger(envPort) && envPort >= 1024 && envPort <= 65535) mcpPort = envPort;
    runtimeKeyConfigured = Boolean(envFile.get('CONTROL_PLANE_API_KEY'));
    service = await linuxServiceState(options);
    tunnelReady = await linuxTunnelReady(options);
  } else {
    try {
      await fs.access(setupSecretPath(normalizedOptions));
      runtimeKeyConfigured = true;
    } catch {}
    const runtime = await windowsRuntimeState(repoRoot);
    service = runtime.service;
    tunnelReady = runtime.tunnelReady;
    if (runtime.port) mcpPort = runtime.port;
  }

  return {
    platform,
    deviceName,
    tunnelId,
    mcpPort,
    accessMode: permission.mode,
    httpScopes: permission.httpScopes,
    service,
    tunnelReady,
    workspaceLabel: workspace.label,
    workspaceRoot: workspace.root,
    runtimeKeyConfigured
  };
}

export async function setAccessMode(repoRoot: string, mode: OwnerPermissionMode, options: TuiConfigOptions = {}): Promise<void> {
  configureManagedEnvironment(options);
  const state = await applyOwnerPermissionMode(repoRoot, mode);
  if (platformOf(options) !== 'win32') {
    await updateEnvFile(linuxOpenAiEnvPath(options), { RWMCP_HTTP_SCOPES: state.httpScopes.join(',') });
  }
}

async function updateLinuxLocalServicePort(port: number, options: TuiConfigOptions): Promise<void> {
  const service = path.join(homeOf(options), '.config', 'systemd', 'user', 'remote-workstation-mcp.service');
  try {
    let text = await fs.readFile(service, 'utf8');
    if (/^Environment=RWMCP_PORT=.*$/m.test(text)) {
      text = text.replace(/^Environment=RWMCP_PORT=.*$/m, `Environment=RWMCP_PORT=${port}`);
    } else if (/^ExecStart=/m.test(text)) {
      text = text.replace(/^ExecStart=/m, `Environment=RWMCP_PORT=${port}\nExecStart=`);
    }
    await fs.writeFile(service, text, { encoding: 'utf8', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export async function setMcpPort(port: number, options: TuiConfigOptions = {}): Promise<void> {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('MCP port must be an integer from 1024 to 65535.');
  const normalizedOptions = { platform: platformOf(options), homeDir: homeOf(options), env: envOf(options) };
  const settings = await loadSetupSettings(normalizedOptions);
  await saveSetupSettings({ ...settings, mcpPort: port }, normalizedOptions);
  if (platformOf(options) !== 'win32') {
    await updateEnvFile(linuxOpenAiEnvPath(options), { RWMCP_PORT: String(port) });
    await updateLinuxLocalServicePort(port, options);
  }
}

export async function setDeviceName(name: string, options: TuiConfigOptions = {}): Promise<void> {
  const value = name.trim();
  if (!value || value.length > 128 || /[\r\n]/.test(value)) throw new Error('Device name must be 1..128 characters without line breaks.');
  const normalizedOptions = { platform: platformOf(options), homeDir: homeOf(options), env: envOf(options) };
  const identity = await loadOrCreateDeviceIdentity(normalizedOptions, envOf(options));
  const file = deviceIdentityPath(normalizedOptions);
  await fs.writeFile(file, `${JSON.stringify({ ...identity, name: value }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  if (platformOf(options) !== 'win32') {
    await fs.chmod(file, 0o600);
    await updateEnvFile(linuxOpenAiEnvPath(options), { RWMCP_DEVICE_NAME: value });
  }
}

export async function setTunnelId(tunnelId: string, options: TuiConfigOptions = {}): Promise<void> {
  const value = tunnelId.trim();
  if (!/^tunnel_[0-9a-f]{32}$/.test(value)) throw new Error("Tunnel ID must match 'tunnel_' followed by 32 lowercase hexadecimal characters.");
  const normalizedOptions = { platform: platformOf(options), homeDir: homeOf(options), env: envOf(options) };
  const settings = await loadSetupSettings(normalizedOptions);
  await saveSetupSettings({ ...settings, tunnelId: value }, normalizedOptions);
  if (platformOf(options) !== 'win32') await updateEnvFile(linuxOpenAiEnvPath(options), { CONTROL_PLANE_TUNNEL_ID: value });
}

export async function setRuntimeApiKey(apiKey: string, options: TuiConfigOptions = {}): Promise<void> {
  const value = apiKey.trim();
  if (!value || value.length < 12 || /[\r\n]/.test(value)) throw new Error('Runtime API key looks invalid.');
  if (platformOf(options) === 'win32') {
    const normalizedOptions = { platform: 'win32' as NodeJS.Platform, homeDir: homeOf(options), env: envOf(options) };
    const secretFile = setupSecretPath(normalizedOptions);
    const base = setupConfigDir(normalizedOptions);
    const currentFile = path.join(base, 'current.txt');
    const currentRoot = (await fs.readFile(currentFile, 'utf8')).trim();
    const helper = path.join(currentRoot, 'scripts', 'windows-secret.ps1');
    const result = await run('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helper, '-Action', 'Set', '-Path', secretFile], process.env, value);
    if (result.code !== 0) throw new Error(result.stderr.trim() || 'Failed to protect the runtime API key with Windows DPAPI.');
    return;
  }
  await updateEnvFile(linuxOpenAiEnvPath(options), { CONTROL_PLANE_API_KEY: value });
}

export async function bootstrapManagedNode(
  repoRoot: string,
  tunnelId: string,
  runtimeApiKey?: string,
  options: TuiConfigOptions = {}
): Promise<TuiRuntimeState> {
  configureManagedEnvironment(options);
  const tunnel = tunnelId.trim();
  if (!/^tunnel_[0-9a-f]{32}$/.test(tunnel)) throw new Error("Tunnel ID must match 'tunnel_' followed by 32 lowercase hexadecimal characters.");
  if (runtimeApiKey?.trim()) await setRuntimeApiKey(runtimeApiKey.trim(), options);
  await setTunnelId(tunnel, options);

  const before = await readTuiRuntimeState(repoRoot, options);
  if (!before.runtimeKeyConfigured) throw new Error('Runtime API key is required for first-time setup.');
  const platform = platformOf(options);
  const home = homeOf(options);
  const env = envOf(options);

  if (platform === 'win32') {
    const configBase = setupConfigDir({ platform, homeDir: home, env });
    const currentFile = path.join(configBase, 'current.txt');
    const currentRoot = (await fs.readFile(currentFile, 'utf8')).trim() || repoRoot;
    const tunnelInstaller = path.join(currentRoot, 'scripts', 'install-openai-tunnel-windows.ps1');
    const install = await run('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tunnelInstaller]);
    if (install.code !== 0) throw new Error(install.stderr.trim() || install.stdout.trim() || 'Failed to install the OpenAI tunnel client.');
    if (runtimeApiKey?.trim()) {
      const tunnelClient = path.join(currentRoot, 'runtime', 'openai-tunnel', 'tunnel-client.exe');
      const verify = await run(tunnelClient, ['admin', 'tunnels', 'get', tunnel, '--json'], {
        ...process.env,
        CONTROL_PLANE_API_KEY: runtimeApiKey.trim(),
        OPENAI_API_KEY: runtimeApiKey.trim()
      });
      if (verify.code !== 0) throw new Error(verify.stderr.trim() || verify.stdout.trim() || 'Tunnel credentials could not be verified.');
    }
    const launcher = path.join(configBase, 'bin', 'rwmcp.ps1');
    const autoUpdate = await run('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launcher, '-Action', 'AutoUpdateOn']);
    if (autoUpdate.code !== 0) throw new Error(autoUpdate.stderr.trim() || 'Failed to enable automatic updates.');
    const startup = await run('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launcher, '-Action', 'AutostartOn']);
    if (startup.code !== 0) throw new Error(startup.stderr.trim() || 'Failed to enable startup.');
    const action = before.service === 'active' ? 'Restart' : 'StartOpenAI';
    const start = await run('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launcher, '-Action', action]);
    if (start.code !== 0) throw new Error(start.stderr.trim() || start.stdout.trim() || 'Failed to start the ChatGPT tunnel runtime.');
  } else {
    const dataBase = path.resolve(env.RWMCP_HOME || path.join(home, '.local', 'share', 'remote-workstation-mcp'));
    const currentRoot = path.join(dataBase, 'current');
    const envFile = await readEnvFile(linuxOpenAiEnvPath(options));
    const key = runtimeApiKey?.trim() || envFile.get('CONTROL_PLANE_API_KEY')?.trim();
    if (!key) throw new Error('Runtime API key is required for Linux Direct Node setup.');
    const tunnelInstaller = path.join(currentRoot, 'scripts', 'install-openai-tunnel-linux.sh');
    const install = await run('bash', [tunnelInstaller], linuxSystemdEnv(options));
    if (install.code !== 0) throw new Error(install.stderr.trim() || install.stdout.trim() || 'Failed to install the OpenAI tunnel client.');
    const tunnelClient = path.join(dataBase, 'runtime', 'openai-tunnel', 'tunnel-client');
    const verify = await run(tunnelClient, ['admin', 'tunnels', 'get', tunnel, '--json'], {
      ...linuxSystemdEnv(options),
      CONTROL_PLANE_API_KEY: key,
      OPENAI_API_KEY: key
    });
    if (verify.code !== 0) throw new Error(verify.stderr.trim() || verify.stdout.trim() || 'Tunnel credentials could not be verified.');
    const script = path.join(currentRoot, 'scripts', 'setup-direct-node-linux.sh');
    const setup = await run('bash', [script, '--tunnel-id', tunnel, '--name', before.deviceName, '--port', String(before.mcpPort)], {
      ...linuxSystemdEnv(options),
      CONTROL_PLANE_API_KEY: key
    });
    if (setup.code !== 0) throw new Error(setup.stderr.trim() || setup.stdout.trim() || 'Linux Direct Node setup failed.');
    const updateEnv = path.join(setupConfigDir({ platform, homeDir: home, env }), 'update.env');
    await updateEnvFile(updateEnv, {
      RWMCP_UPDATE_MODE: 'auto_patch',
      RWMCP_UPDATE_REPO: 'Tunglam0605/remote-workstation-mcp'
    });
    const updateTimer = await run('systemctl', ['--user', 'enable', '--now', 'remote-workstation-mcp-update.timer'], linuxSystemdEnv(options));
    if (updateTimer.code !== 0) throw new Error(updateTimer.stderr.trim() || 'Failed to enable automatic update timer.');
  }

  for (let attempt = 0; attempt < 70; attempt += 1) {
    const state = await readTuiRuntimeState(repoRoot, options);
    if (state.service === 'active' && state.tunnelReady === true) return state;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return await readTuiRuntimeState(repoRoot, options);
}
export async function restartManagedRuntime(repoRoot: string, options: TuiConfigOptions = {}): Promise<string> {
  const configBase = setupConfigDir({ platform: platformOf(options), homeDir: homeOf(options), env: envOf(options) });
  const interlocks = new NodeInterlockStore('owner-local-lifecycle', {
    file: path.join(configBase, 'runtime', 'work-session-interlocks.json')
  });
  await interlocks.reconcileStale();
  const active = await interlocks.listActive();
  if (active.length > 0) {
    throw new Error(`NODE_BUSY: ${active.length} active Work Session workflow interlock(s) prevent runtime restart.`);
  }
  if (platformOf(options) === 'win32') {
    const configuredLauncher = process.env.RWMCP_WINDOWS_LAUNCHER?.trim();
    const launcher = configuredLauncher || path.resolve(repoRoot, '..', '..', 'bin', 'rwmcp.ps1');
    const result = await run('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launcher, '-Action', 'Restart']);
    if (result.code !== 0) throw new Error(result.stderr.trim() || 'Windows runtime restart failed.');
    return 'Windows runtime restart accepted.';
  }
  await run('systemctl', ['--user', 'daemon-reload']);
  const direct = await run('systemctl', ['--user', 'is-enabled', 'remote-workstation-mcp-openai.service']);
  const unit = direct.code === 0 ? 'remote-workstation-mcp-openai.service' : 'remote-workstation-mcp.service';
  const result = await run('systemctl', ['--user', 'restart', unit]);
  if (result.code !== 0) throw new Error(result.stderr.trim() || `Failed to restart ${unit}.`);
  return `${unit} restarted.`;
}