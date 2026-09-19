import type { ConcurrencyClass } from './work-session.js';

export const CONCURRENCY_OPERATIONS = [
  'filesystem.read',
  'git.read',
  'project.inspect',
  'provider.status',
  'source.edit',
  'git.worktree',
  'build.isolated',
  'hardware.serial',
  'hardware.debug-probe',
  'hardware.can-adapter',
  'camera.config',
  'build.keil-shared-output',
  'generated.shared-files',
  'node.update',
  'node.restart',
  'node.reboot',
  'system.major-config',
  'owner.policy',
  'owner.permissions',
  'owner.security-grants'
] as const;

export type ConcurrencyOperation = typeof CONCURRENCY_OPERATIONS[number];

export interface ConcurrencyDecision {
  operation: ConcurrencyOperation;
  class: ConcurrencyClass;
  keyRequired: boolean;
  reason: string;
}

const DECISIONS: Record<ConcurrencyOperation, Omit<ConcurrencyDecision, 'operation'>> = {
  'filesystem.read': { class: 'shared', keyRequired: false, reason: 'Read-only filesystem access may run concurrently.' },
  'git.read': { class: 'shared', keyRequired: false, reason: 'Read-only Git inspection may run concurrently.' },
  'project.inspect': { class: 'shared', keyRequired: false, reason: 'Project inspection is read-only and shareable.' },
  'provider.status': { class: 'shared', keyRequired: false, reason: 'Provider status is read-only.' },
  'source.edit': { class: 'session-isolated', keyRequired: true, reason: 'Writable source state must be isolated by Work Session/worktree.' },
  'git.worktree': { class: 'session-isolated', keyRequired: true, reason: 'Each writable Work Session owns its branch and worktree.' },
  'build.isolated': { class: 'session-isolated', keyRequired: true, reason: 'Build outputs must remain inside a session-isolated directory.' },
  'hardware.serial': { class: 'resource-exclusive', keyRequired: true, reason: 'An exclusive serial endpoint cannot be mutated by multiple sessions.' },
  'hardware.debug-probe': { class: 'resource-exclusive', keyRequired: true, reason: 'A debug probe is single-owner while flashing/debugging.' },
  'hardware.can-adapter': { class: 'resource-exclusive', keyRequired: true, reason: 'A mutable CAN adapter session is resource-exclusive.' },
  'camera.config': { class: 'resource-exclusive', keyRequired: true, reason: 'Production camera configuration is exclusive; read-only observation remains separate.' },
  'build.keil-shared-output': { class: 'project-variant-exclusive', keyRequired: true, reason: 'Keil targets with non-isolated output directories must serialize per project/variant.' },
  'generated.shared-files': { class: 'project-variant-exclusive', keyRequired: true, reason: 'Generated files shared by a variant must not be written concurrently.' },
  'node.update': { class: 'node-exclusive', keyRequired: true, reason: 'Runtime update affects the whole node.' },
  'node.restart': { class: 'node-exclusive', keyRequired: true, reason: 'Runtime restart affects all sessions on the node.' },
  'node.reboot': { class: 'node-exclusive', keyRequired: true, reason: 'Host reboot affects all node resources.' },
  'system.major-config': { class: 'node-exclusive', keyRequired: true, reason: 'Major system configuration is node-wide.' },
  'owner.policy': { class: 'owner-local-only', keyRequired: false, reason: 'Policy mutation remains owner-local and is never delegated to Work Sessions.' },
  'owner.permissions': { class: 'owner-local-only', keyRequired: false, reason: 'Permission grants remain owner-local.' },
  'owner.security-grants': { class: 'owner-local-only', keyRequired: false, reason: 'Security/federation grants remain owner-local.' }
};

export class ConcurrencyPolicy {
  classify(operation: ConcurrencyOperation): ConcurrencyDecision {
    return { operation, ...DECISIONS[operation] };
  }
}
