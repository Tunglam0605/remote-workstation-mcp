import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

export const SETUP_SETTINGS_VERSION = 1 as const;
export const DEFAULT_CONTROL_PORT = 8684 as const;
export type ExecutionMode = 'rwmcp-only' | 'codex-only' | 'both';

export const DEFAULT_HTTP_SCOPES = [
  'workstation.read',
  'workstation.write',
  'workstation.execute',
  'workstation.admin_request'
] as const;

const codexAccountBrokerSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  mode: z.enum(['native', 'cockpit-api-pool']).default('native')
});

export const executionSettingsSchema = z.object({
  codexEnabled: z.boolean().default(false),
  defaultMode: z.enum(['rwmcp-only', 'codex-only', 'both']).default('rwmcp-only'),
  allowChatOverride: z.boolean().default(true),
  codexFallback: z.enum(['rwmcp-only', 'stop']).default('rwmcp-only'),
  maxCodexTasksPerSession: z.number().int().min(0).max(10000).default(0),
  maxCodexTasksPerDay: z.number().int().min(0).max(100000).default(0),
  codexAccountBroker: codexAccountBrokerSettingsSchema.default({
    enabled: false,
    mode: 'native'
  })
});

const workstationScopeSchema = z.enum([
  'workstation.read',
  'workstation.write',
  'workstation.execute',
  'workstation.admin_request',
  'workstation.full_control',
  'workstation.cross_node_transfer'
]);

export const setupSettingsSchema = z.object({
  version: z.literal(SETUP_SETTINGS_VERSION).default(SETUP_SETTINGS_VERSION),
  mcpPort: z.number().int().min(1024).max(65535).default(8683),
  workspaceRoot: z.string().trim().min(1).max(4096),
  tunnelId: z.string().trim().max(128).default(''),
  organizationId: z.string().trim().max(128).default(''),
  cloudflaredManaged: z.boolean().default(false),
  controlPort: z.number().int().min(1024).max(65535).default(DEFAULT_CONTROL_PORT),
  httpScopes: z.array(workstationScopeSchema).min(1).default([...DEFAULT_HTTP_SCOPES])
    .refine(scopes => scopes.includes('workstation.read'), { message: 'httpScopes must include workstation.read.' })
    .refine(scopes => new Set(scopes).size === scopes.length, { message: 'httpScopes must not contain duplicates.' }),
  execution: executionSettingsSchema.default({
    codexEnabled: false,
    defaultMode: 'rwmcp-only',
    allowChatOverride: true,
    codexFallback: 'rwmcp-only',
    maxCodexTasksPerSession: 0,
    maxCodexTasksPerDay: 0,
    codexAccountBroker: { enabled: false, mode: 'native' }
  })
});

export type SetupSettings = z.infer<typeof setupSettingsSchema>;

export interface SetupPathOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDir?: string;
}

function homeDirectory(options: SetupPathOptions): string {
  return options.homeDir ?? os.homedir();
}

export function defaultWorkspaceRoot(options: SetupPathOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const home = homeDirectory(options);
  return platform === 'win32'
    ? path.join(home, 'Documents', 'RemoteWorkspaces')
    : path.join(home, 'RemoteWorkspaces');
}

export function setupConfigDir(options: SetupPathOptions = {}): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = homeDirectory(options);
  if (platform === 'win32') {
    return path.resolve(env.LOCALAPPDATA ?? env.APPDATA ?? path.join(home, 'AppData', 'Local'), 'RemoteWorkstationMCP');
  }
  return path.resolve(env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'remote-workstation-mcp');
}

export function setupSettingsPath(options: SetupPathOptions = {}): string {
  return path.join(setupConfigDir(options), 'settings.json');
}

export function setupSecretPath(options: SetupPathOptions = {}): string {
  return path.join(setupConfigDir(options), 'secrets', 'openai-runtime-api-key.dpapi');
}

export function normalizeSetupSettings(input: unknown, options: SetupPathOptions = {}): SetupSettings {
  const raw = (input && typeof input === 'object') ? input as Record<string, unknown> : {};
  const requestedMcpPort = raw.mcpPort ?? 8683;
  const migratedControlPort = raw.controlPort ?? (requestedMcpPort === DEFAULT_CONTROL_PORT ? DEFAULT_CONTROL_PORT + 1 : DEFAULT_CONTROL_PORT);
  const existingScopes = Array.isArray(raw.httpScopes) ? raw.httpScopes.map(String) : [...DEFAULT_HTTP_SCOPES];
  const migratedScopes = existingScopes.includes('workstation.execute') && !existingScopes.includes('workstation.admin_request')
    ? [...existingScopes, 'workstation.admin_request']
    : existingScopes;
  const parsed = setupSettingsSchema.parse({
    version: raw.version ?? SETUP_SETTINGS_VERSION,
    mcpPort: requestedMcpPort,
    workspaceRoot: raw.workspaceRoot ?? defaultWorkspaceRoot(options),
    tunnelId: raw.tunnelId ?? '',
    organizationId: raw.organizationId ?? '',
    cloudflaredManaged: raw.cloudflaredManaged ?? false,
    controlPort: migratedControlPort,
    httpScopes: migratedScopes,
    execution: raw.execution ?? {
      codexEnabled: false,
      defaultMode: 'rwmcp-only',
      allowChatOverride: true,
      codexFallback: 'rwmcp-only',
      maxCodexTasksPerSession: 0,
      maxCodexTasksPerDay: 0,
      codexAccountBroker: { enabled: false, mode: 'native' }
    }
  });

  if (!path.isAbsolute(parsed.workspaceRoot)) {
    throw new Error('workspaceRoot must be an absolute path.');
  }
  if (parsed.mcpPort === parsed.controlPort) {
    throw new Error('mcpPort and controlPort must use different loopback ports.');
  }
  if (parsed.tunnelId && !/^tunnel_[0-9a-f]{32}$/.test(parsed.tunnelId)) {
    throw new Error("tunnelId must be empty or match 'tunnel_' followed by 32 lowercase hexadecimal characters.");
  }
  if (parsed.organizationId && !/^org[-_][A-Za-z0-9]+$/.test(parsed.organizationId)) {
    throw new Error("organizationId must be empty or begin with 'org-' / 'org_'.");
  }
  return parsed;
}

export async function loadSetupSettings(options: SetupPathOptions = {}): Promise<SetupSettings> {
  const file = setupSettingsPath(options);
  try {
    const text = await fs.readFile(file, 'utf8');
    const raw = JSON.parse(text.replace(/^\uFEFF/, '')) as unknown;
    return normalizeSetupSettings(raw, options);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return normalizeSetupSettings({}, options);
    }
    throw error;
  }
}

export async function saveSetupSettings(settings: SetupSettings, options: SetupPathOptions = {}): Promise<string> {
  const normalized = normalizeSetupSettings(settings, options);
  const file = setupSettingsPath(options);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temp, file);
  if ((options.platform ?? process.platform) !== 'win32') await fs.chmod(file, 0o600);
  return file;
}

function configuredPath(envName: 'RWMCP_POLICY' | 'RWMCP_HOSTS', fallback: string): string {
  const configured = process.env[envName]?.trim();
  return path.resolve(configured || fallback);
}

export async function ensureDefaultPolicy(repoRoot: string, workspaceRoot: string): Promise<{ path: string; created: boolean }> {
  const policyPath = configuredPath('RWMCP_POLICY', path.join(repoRoot, 'config', 'policy.yaml'));
  await fs.mkdir(path.dirname(policyPath), { recursive: true });
  try {
    await fs.access(policyPath);
    return { path: policyPath, created: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const normalizedRoot = workspaceRoot.replace(/\\/g, '/').replace(/"/g, '\\"');
  const policy = `version: 1\nmode: workspace\n\nworkspaces:\n  - id: projects\n    name: Projects\n    root: "${normalizedRoot}"\n    readOnly: false\n\nfilesystem:\n  maxReadBytes: 1048576\n  maxWriteBytes: 1048576\n\nsearch:\n  maxResults: 100\n  maxFiles: 5000\n  maxFileBytes: 1048576\n\nprocess:\n  allowExecutables:\n    - git\n    - node\n    - python\n    - py\n    - cmake\n    - ninja\n  inheritEnv:\n    - PATH\n    - USERPROFILE\n    - HOME\n    - LANG\n    - TEMP\n    - TMP\n  maxOutputBytes: 262144\n  maxRuntimeMs: 600000\n  maxInputBytes: 65536\n\ntasks: {}\n\nfullControl:\n  allowRawShell: false\n  allowHostFilesystem: false\n\nprivileged:\n  allowSudo: false\n  maxRuntimeMs: 600000\n`;
  await fs.writeFile(policyPath, policy, { encoding: 'utf8', mode: 0o600 });
  return { path: policyPath, created: true };
}

export async function ensureHostsConfig(repoRoot: string): Promise<{ path: string; created: boolean }> {
  const hostsPath = configuredPath('RWMCP_HOSTS', path.join(repoRoot, 'config', 'hosts.yaml'));
  await fs.mkdir(path.dirname(hostsPath), { recursive: true });
  try {
    await fs.access(hostsPath);
    return { path: hostsPath, created: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await fs.writeFile(hostsPath, 'version: 1\nhosts: []\n', { encoding: 'utf8', mode: 0o600 });
  return { path: hostsPath, created: true };
}
