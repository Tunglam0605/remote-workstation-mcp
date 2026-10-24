import { validateHandoffManifest, type HandoffManifestV1 } from './handoff-manifest.js';

export interface OwnerTrustedBuildProfile {
  id: string;
  projectId: string;
  target: string;
  sourceNodeId: string;
  sourceRevision: string;
  allowed: boolean;
  destinationWorkspace?: string;
}

export interface HandoffBuildIntent {
  manifest: HandoffManifestV1;
  localNodeId: string;
  workspaceId: string;
  requestedProfileId: string;
  requestedTarget: string;
  cleanSnapshot: boolean;
  buildHooks: string[];
  sourceRevision: string;
  ownerProfiles: readonly OwnerTrustedBuildProfile[];
}

/** This is a preflight contract, not an executor. Never run imported build scripts or flash from this function. */
export function validateHandoffBuildIntent(intent: HandoffBuildIntent): {
  eligible: true;
  profileId: string;
  target: string;
} {
  const manifest = validateHandoffManifest(intent.manifest);
  if (manifest.role !== 'source') throw new Error('Only verified source handoffs may enter a build preflight.');
  if (manifest.destinationNodeId !== intent.localNodeId || manifest.destinationWorkspace !== intent.workspaceId) {
    throw new Error('Build destination node/workspace does not match manifest.');
  }
  if (!intent.cleanSnapshot) throw new Error('Dirty or modified snapshot cannot be built by automatic handoff.');
  if (intent.sourceRevision !== manifest.sourceRevision) throw new Error('Source revision differs from manifest.');
  if (intent.buildHooks.length) throw new Error('Downloaded or unapproved project build hooks are forbidden in automatic handoff.');
  const approved = intent.ownerProfiles.find(profile => profile.allowed &&
    profile.id === intent.requestedProfileId && profile.id === manifest.toolchainProfileId &&
    profile.projectId === manifest.projectId && profile.sourceNodeId === manifest.sourceNodeId &&
    profile.sourceRevision === manifest.sourceRevision &&
    (profile.destinationWorkspace === undefined || profile.destinationWorkspace === intent.workspaceId));
  if (!approved) throw new Error('No matching receiver owner-approved build profile exists.');
  if (approved.target !== intent.requestedTarget) throw new Error('Requested toolchain target does not match owner profile.');
  return { eligible: true, profileId: approved.id, target: approved.target };
}
