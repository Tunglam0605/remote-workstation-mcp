import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import type { PermissionLease } from '../model.js';
import { loadPermissionLease } from '../permissions.js';
import {
  DEFAULT_HTTP_SCOPES,
  ensureDefaultPolicy,
  loadSetupSettings,
  saveSetupSettings,
  setupConfigDir,
  type SetupSettings
} from './settings.js';

const ALLOWED_SCOPES = new Set([
  'workstation.read',
  'workstation.write',
  'workstation.execute',
  'workstation.full_control'
]);
const ALLOWED_TTLS = new Set([10, 30, 60]);

export interface PermissionConfigInput {
  httpScopes: string[];
  allowHostFilesystem: boolean;
  allowRawShell: boolean;
}

export interface PermissionState {
  httpScopes: string[];
  allowHostFilesystem: boolean;
  allowRawShell: boolean;
  policyPath: string;
  leasePath: string;
  lease?: PermissionLease & { active: boolean; remainingSeconds: number };
}

export function managedLeasePath(): string {
  return path.resolve(
    process.env.RWMCP_LEASE?.trim() || path.join(setupConfigDir(), 'runtime', 'permission-lease.json')
  );
}

export function managedPolicyPath(repoRoot: string): string {
  return path.resolve(process.env.RWMCP_POLICY?.trim() || path.join(repoRoot, 'config', 'policy.yaml'));
}

function normalizeScopes(scopes: readonly string[]): string[] {
  const requested = new Set(scopes.map(scope => String(scope).trim()).filter(Boolean));
  for (const scope of requested) {
    if (!ALLOWED_SCOPES.has(scope)) throw new Error(`Unsupported workstation scope '${scope}'.`);
  }
  requested.add('workstation.read');
  // Full-control transport authorization semantically implies the ordinary
  // read/write/execute scopes. Persist that implication explicitly so the UI,
  // audit/status output and runtime authorization all describe the same access.
  if (requested.has('workstation.full_control')) {
    requested.add('workstation.write');
    requested.add('workstation.execute');
  }
  return [
    'workstation.read',
    'workstation.write',
    'workstation.execute',
    'workstation.full_control'
  ].filter(scope => requested.has(scope));
}

async function loadPolicyDocument(repoRoot: string): Promise<{ file: string; document: YAML.Document.Parsed }> {
  const file = managedPolicyPath(repoRoot);
  const raw = await fs.readFile(file, 'utf8');
  const document = YAML.parseDocument(raw);
  if (document.errors.length) throw new Error(`Policy YAML is invalid: ${document.errors[0]?.message ?? 'unknown error'}`);
  return { file, document };
}

async function atomicWrite(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, content, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temp, file);
}

export async function readPermissionState(repoRoot: string): Promise<PermissionState> {
  const settings = await loadSetupSettings();
  await ensureDefaultPolicy(repoRoot, settings.workspaceRoot);
  const { file, document } = await loadPolicyDocument(repoRoot);
  const allowHostFilesystem = document.getIn(['fullControl', 'allowHostFilesystem']) === true;
  const allowRawShell = document.getIn(['fullControl', 'allowRawShell']) === true;
  const leasePath = managedLeasePath();
  const lease = await loadPermissionLease(leasePath);
  const expiresAt = lease ? Date.parse(lease.expiresAt) : 0;
  const remainingSeconds = lease ? Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)) : 0;
  return {
    httpScopes: normalizeScopes(settings.httpScopes ?? [...DEFAULT_HTTP_SCOPES]),
    allowHostFilesystem,
    allowRawShell,
    policyPath: file,
    leasePath,
    ...(lease ? { lease: { ...lease, active: remainingSeconds > 0, remainingSeconds } } : {})
  };
}

export async function applyPermissionConfig(repoRoot: string, input: PermissionConfigInput): Promise<PermissionState> {
  const httpScopes = normalizeScopes(input.httpScopes);
  const settings = await loadSetupSettings();
  await ensureDefaultPolicy(repoRoot, settings.workspaceRoot);
  await saveSetupSettings({ ...settings, httpScopes } as SetupSettings);

  const { file, document } = await loadPolicyDocument(repoRoot);
  document.setIn(['fullControl', 'allowHostFilesystem'], Boolean(input.allowHostFilesystem));
  document.setIn(['fullControl', 'allowRawShell'], Boolean(input.allowRawShell));
  await atomicWrite(file, String(document));
  return await readPermissionState(repoRoot);
}

export async function grantFullControlLease(
  ttlMinutes: number,
  clientId = 'openai-tunnel',
  reason = 'owner enabled from local Control Center'
): Promise<PermissionState['lease']> {
  if (!ALLOWED_TTLS.has(ttlMinutes)) throw new Error('Lease TTL must be 10, 30 or 60 minutes.');
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(clientId)) throw new Error('Invalid lease client ID.');
  const now = new Date();
  const lease: PermissionLease = {
    mode: 'full_control',
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMinutes * 60_000).toISOString(),
    clientId,
    reason
  };
  const file = managedLeasePath();
  await atomicWrite(file, `${JSON.stringify(lease, null, 2)}\n`);
  return { ...lease, active: true, remainingSeconds: ttlMinutes * 60 };
}

export async function revokePermissionLease(): Promise<void> {
  await fs.rm(managedLeasePath(), { force: true });
}
