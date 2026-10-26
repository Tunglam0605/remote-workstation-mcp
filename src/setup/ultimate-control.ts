import path from 'node:path';
import { loadPolicy } from '../config.js';
import { loadOrCreateDeviceIdentity } from '../device-identity.js';
import { UltimateConsentManager, type UltimateActivation, type UltimateStatus, type UltimateLifecycleEvent } from '../security/ultimate-consent.js';
import { readPermissionState, managedPolicyPath } from './permissions.js';
import { loadSetupSettings, setupConfigDir } from './settings.js';

export interface OwnerUltimateState extends UltimateStatus {
  nodeId: string;
  baseMode: string;
  permanentFullAccessWarning: boolean;
  authority: 'owner-local-only';
  platformSupported: boolean;
  availableWorkspaces: Array<{ id: string; name: string }>;
  availableTransferGrants: Array<{ id: string; sourceNodeId: string; destinationNodeId: string }>;
  httpScopes: string[];
  recentEvents: UltimateLifecycleEvent[];
}

function ownerManager(): UltimateConsentManager {
  const runtime = path.join(setupConfigDir(), 'runtime');
  return new UltimateConsentManager({
    filePath: path.join(runtime, 'ultimate-consent.json'),
    epochPath: path.join(runtime, 'ultimate-runtime-epoch.json')
  });
}

export async function readOwnerUltimateState(repoRoot: string): Promise<OwnerUltimateState> {
  const [permission, identity, status, policy, settings, recentEvents] = await Promise.all([
    readPermissionState(repoRoot),
    loadOrCreateDeviceIdentity(),
    ownerManager().status(),
    loadPolicy(managedPolicyPath(repoRoot)),
    loadSetupSettings(),
    ownerManager().recentEvents()
  ]);
  return {
    ...status,
    nodeId: identity.id,
    baseMode: permission.mode,
    permanentFullAccessWarning: permission.mode === 'full_control',
    authority: 'owner-local-only',
    recentEvents,
    platformSupported: process.platform === 'win32',
    availableWorkspaces: policy.workspaces.filter(workspace => !workspace.readOnly).map(workspace => ({
      id: workspace.id, name: workspace.name ?? workspace.id
    })),
    availableTransferGrants: (policy.multiNode?.enabled ? (policy.multiNode.grants ?? []) : [])
      .filter(grant => grant.enabled !== false && (grant.sourceNodeId === identity.id || grant.destinationNodeId === identity.id))
      .map(grant => ({ id: grant.id, sourceNodeId: grant.sourceNodeId, destinationNodeId: grant.destinationNodeId })),
    httpScopes: settings.httpScopes
  };
}

export async function activateOwnerUltimate(
  repoRoot: string,
  raw: { durationMinutes?: unknown; scope?: unknown },
  runtimePlatform: NodeJS.Platform = process.platform
): Promise<OwnerUltimateState> {
  if (runtimePlatform !== 'win32') throw new Error('Ultimate Control activation is Windows-only in this release. Ubuntu remains frozen.');
  const [policy, settings, identity] = await Promise.all([
    loadPolicy(managedPolicyPath(repoRoot)),
    loadSetupSettings(),
    loadOrCreateDeviceIdentity()
  ]);
  if (!raw || typeof raw !== 'object' || !raw.scope || typeof raw.scope !== 'object') {
    throw new Error('Ultimate activation requires explicit durationMinutes and scope.');
  }
  const scope = raw.scope as UltimateActivation['scope'];
  if (!Array.isArray(scope.operations) || !Array.isArray(scope.workspaces) ||
      !Array.isArray(scope.profileIds) || !Array.isArray(scope.transferGrantIds)) {
    throw new Error('Ultimate scope requires operations, workspaces, profileIds and transferGrantIds arrays.');
  }
  if (scope.operations.some(operation => !['build', 'test', 'workspace_add', 'transfer', 'artifact_verify'].includes(operation))) {
    throw new Error('Unsupported Ultimate operation.');
  }
  if (scope.workspaces.some(id => !policy.workspaces.some(ws => ws.id === id && !ws.readOnly))) {
    throw new Error('Ultimate workspace is not an authorized writable workspace.');
  }
  if (policy.mode === 'read_only' && scope.operations.some(operation => operation !== 'artifact_verify')) {
    throw new Error('Ultimate cannot widen read_only local policy.');
  }
  const scopes = new Set(settings.httpScopes);
  if (scope.operations.some(operation => operation === 'build' || operation === 'test') && !scopes.has('workstation.execute')) {
    throw new Error('Ultimate build/test requires existing workstation.execute scope.');
  }
  if (scope.operations.includes('workspace_add') &&
      (!scopes.has('workstation.write') || !scopes.has('workstation.execute'))) {
    throw new Error('Ultimate workspace handoff requires both workstation.write and workstation.execute scopes for the existing engineering workflow envelope.');
  }
  if (scope.operations.includes('transfer')) {
    if (!policy.multiNode?.enabled || !scopes.has('workstation.cross_node_transfer')) {
      throw new Error('Ultimate transfer requires locally enabled multi-node scope and grants.');
    }
    if (!scope.transferGrantIds.length) throw new Error('Ultimate transfer requires an exact owner-approved grant.');
  }
  if (scope.operations.some(operation => operation === 'build' || operation === 'test') && !scope.profileIds.length) {
    throw new Error('Ultimate build/test requires named owner-approved profileIds.');
  }
  const enabled = policy.multiNode?.grants.filter(grant =>
    grant.enabled !== false &&
    (grant.sourceNodeId === identity.id || grant.destinationNodeId === identity.id)
  ) ?? [];
  if (scope.transferGrantIds.some(id => !enabled.some(grant => grant.id === id))) {
    throw new Error('Ultimate transfer grant is not locally authorized for this node.');
  }
  const principalId = policy.multiNode?.controllerPrincipalId || 'openai-tunnel';
  await ownerManager().activate({
    nodeId: identity.id,
    principalId,
    durationMinutes: raw.durationMinutes as UltimateActivation['durationMinutes'],
    scope
  });
  return await readOwnerUltimateState(repoRoot);
}

export async function revokeOwnerUltimate(): Promise<void> {
  await ownerManager().revoke();
}
