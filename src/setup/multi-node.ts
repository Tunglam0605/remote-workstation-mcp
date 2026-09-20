import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { loadPolicy, multiNodeGrantSchema } from '../config.js';
import { loadOrCreateDeviceIdentity } from '../device-identity.js';
import type { MultiNodeTransferGrantConfig } from '../model.js';
import {
  ensureDefaultPolicy,
  loadSetupSettings,
  saveSetupSettings,
  type SetupSettings
} from './settings.js';

const CROSS_NODE_SCOPE = 'workstation.cross_node_transfer' as const;
const MAX_GRANTS = 256;

export interface OwnerMultiNodeState {
  localNodeId: string;
  localNodeName: string;
  enabled: boolean;
  controllerPrincipalId: string;
  controllerPrincipalType: string;
  grants: MultiNodeTransferGrantConfig[];
  requiredScope: typeof CROSS_NODE_SCOPE;
  scopeEnabled: boolean;
  configurationConsistent: boolean;
  policyPath: string;
}

function policyPath(repoRoot: string): string {
  return path.resolve(process.env.RWMCP_POLICY?.trim() || path.join(repoRoot, 'config', 'policy.yaml'));
}

async function atomicWrite(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, content, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temp, file);
  if (process.platform !== 'win32') await fs.chmod(file, 0o600);
}

async function loadDocument(repoRoot: string): Promise<{ file: string; document: YAML.Document.Parsed }> {
  const settings = await loadSetupSettings();
  await ensureDefaultPolicy(repoRoot, settings.workspaceRoot);
  const file = policyPath(repoRoot);
  const raw = await fs.readFile(file, 'utf8');
  const document = YAML.parseDocument(raw);
  if (document.errors.length) {
    throw new Error(`Policy YAML is invalid: ${document.errors[0]?.message ?? 'unknown error'}`);
  }
  return { file, document };
}

function normalizeRelative(value: string, field: string): string {
  const trimmed = value.trim().replaceAll('\\', '/');
  if (!trimmed) throw new Error(field + ' must not be empty.');
  if (trimmed.startsWith('/') || /^[A-Za-z]:\//.test(trimmed)) {
    throw new Error(field + ' must be relative.');
  }
  const parts = trimmed.split('/').filter(part => part && part !== '.');
  if (parts.includes('..')) throw new Error(field + ' must not contain traversal.');
  return parts.length ? parts.join('/') : '.';
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export function normalizeOwnerMultiNodeGrant(input: unknown): MultiNodeTransferGrantConfig {
  const parsed = multiNodeGrantSchema.parse(input);
  return {
    ...parsed,
    sourcePathPrefixes: unique(parsed.sourcePathPrefixes.map((value, index) =>
      normalizeRelative(value, `sourcePathPrefixes[${index}]`)
    )),
    destinationBasePaths: unique(parsed.destinationBasePaths.map((value, index) =>
      normalizeRelative(value, `destinationBasePaths[${index}]`)
    )),
    allowedExtensions: unique(parsed.allowedExtensions.map(value => value.toLowerCase())),
    transports: unique(parsed.transports)
  };
}

async function writeMultiNodeConfig(
  repoRoot: string,
  config: {
    enabled: boolean;
    controllerPrincipalId: string;
    controllerPrincipalType: string;
    grants: MultiNodeTransferGrantConfig[];
  }
): Promise<void> {
  if (config.grants.length > MAX_GRANTS) throw new Error('Multi-node grant limit reached.');
  const { file, document } = await loadDocument(repoRoot);
  document.set('multiNode', config);
  await atomicWrite(file, String(document));
  await loadPolicy(file);
}

function settingsWithCrossNodeScope(settings: SetupSettings, enabled: boolean): SetupSettings {
  const scopes: SetupSettings['httpScopes'] = settings.httpScopes.filter(scope => scope !== CROSS_NODE_SCOPE);
  if (enabled) scopes.push(CROSS_NODE_SCOPE);
  return { ...settings, httpScopes: scopes };
}

export async function readOwnerMultiNodeState(repoRoot: string): Promise<OwnerMultiNodeState> {
  const identity = await loadOrCreateDeviceIdentity();
  const settings = await loadSetupSettings();
  await ensureDefaultPolicy(repoRoot, settings.workspaceRoot);
  const file = policyPath(repoRoot);
  const policy = await loadPolicy(file);
  const config = policy.multiNode ?? {
    enabled: false,
    controllerPrincipalId: 'openai-tunnel',
    controllerPrincipalType: 'openai-secure-mcp-tunnel',
    grants: []
  };
  const scopeEnabled = settings.httpScopes.includes(CROSS_NODE_SCOPE);
  return {
    localNodeId: identity.id,
    localNodeName: identity.name,
    enabled: config.enabled,
    controllerPrincipalId: config.controllerPrincipalId,
    controllerPrincipalType: config.controllerPrincipalType,
    grants: config.grants.map(grant => structuredClone(grant)),
    requiredScope: CROSS_NODE_SCOPE,
    scopeEnabled,
    configurationConsistent: config.enabled === scopeEnabled,
    policyPath: file
  };
}

export async function setOwnerMultiNodeEnabled(
  repoRoot: string,
  enabled: boolean
): Promise<OwnerMultiNodeState & { restartRequired: true }> {
  const current = await readOwnerMultiNodeState(repoRoot);
  const settings = await loadSetupSettings();
  const nextConfig = {
    enabled,
    controllerPrincipalId: current.controllerPrincipalId,
    controllerPrincipalType: current.controllerPrincipalType,
    grants: current.grants
  };

  if (enabled) {
    await saveSetupSettings(settingsWithCrossNodeScope(settings, true));
    await writeMultiNodeConfig(repoRoot, nextConfig);
  } else {
    await writeMultiNodeConfig(repoRoot, nextConfig);
    await saveSetupSettings(settingsWithCrossNodeScope(settings, false));
  }

  return { ...(await readOwnerMultiNodeState(repoRoot)), restartRequired: true };
}

export async function upsertOwnerMultiNodeGrant(
  repoRoot: string,
  input: unknown
): Promise<OwnerMultiNodeState> {
  const grant = normalizeOwnerMultiNodeGrant(input);
  const current = await readOwnerMultiNodeState(repoRoot);
  const grants = current.grants.map(item => structuredClone(item));
  const index = grants.findIndex(item => item.id === grant.id);
  if (index >= 0) grants[index] = grant;
  else {
    if (grants.length >= MAX_GRANTS) throw new Error('Multi-node grant limit reached.');
    grants.push(grant);
  }
  await writeMultiNodeConfig(repoRoot, {
    enabled: current.enabled,
    controllerPrincipalId: current.controllerPrincipalId,
    controllerPrincipalType: current.controllerPrincipalType,
    grants
  });
  return await readOwnerMultiNodeState(repoRoot);
}

export async function removeOwnerMultiNodeGrant(
  repoRoot: string,
  grantId: string
): Promise<OwnerMultiNodeState> {
  const normalized = grantId.trim();
  if (!/^[A-Za-z0-9._-]{1,96}$/.test(normalized)) throw new Error('Invalid multi-node grant id.');
  const current = await readOwnerMultiNodeState(repoRoot);
  const grants = current.grants.filter(item => item.id !== normalized);
  await writeMultiNodeConfig(repoRoot, {
    enabled: current.enabled,
    controllerPrincipalId: current.controllerPrincipalId,
    controllerPrincipalType: current.controllerPrincipalType,
    grants
  });
  return await readOwnerMultiNodeState(repoRoot);
}
