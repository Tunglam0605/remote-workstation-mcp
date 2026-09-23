import { randomUUID } from 'node:crypto';
import type { OfficeBackendId, OfficeEvidenceArtifact, OfficeValidationResult } from './contracts.js';
import type { OfficeDocumentIdentity } from './document-identity.js';
import { sameOfficeDocumentRevision } from './document-identity.js';

export const OFFICE_TRANSACTION_STATES = [
  'open', 'inspected', 'snapshotted', 'working', 'patched', 'app-opened', 'rendered',
  'validated', 'accepted', 'committed', 'rollback-pending', 'rolled-back', 'conflict', 'failed'
] as const;
export type OfficeTransactionState = typeof OFFICE_TRANSACTION_STATES[number];

export interface OfficeTransaction {
  version: 1;
  id: string;
  state: OfficeTransactionState;
  principalId: string;
  workSessionId: string;
  original: OfficeDocumentIdentity;
  backupPath?: string;
  workingCopyPath?: string;
  selectedBackends: OfficeBackendId[];
  evidence: OfficeEvidenceArtifact[];
  validation?: OfficeValidationResult;
  createdAt: string;
  updatedAt: string;
  failureReason?: string;
}

const TERMINAL = new Set<OfficeTransactionState>(['committed', 'rolled-back', 'conflict', 'failed']);
const ALLOWED: Record<OfficeTransactionState, ReadonlySet<OfficeTransactionState>> = {
  open: new Set(['inspected', 'failed']),
  inspected: new Set(['snapshotted', 'failed']),
  snapshotted: new Set(['working', 'rollback-pending', 'failed']),
  working: new Set(['patched', 'rollback-pending', 'failed']),
  patched: new Set(['app-opened', 'rendered', 'validated', 'rollback-pending', 'failed']),
  'app-opened': new Set(['rendered', 'validated', 'rollback-pending', 'failed']),
  rendered: new Set(['validated', 'rollback-pending', 'failed']),
  validated: new Set(['accepted', 'rollback-pending', 'failed']),
  accepted: new Set(['committed', 'rollback-pending', 'conflict', 'failed']),
  committed: new Set(),
  'rollback-pending': new Set(['rolled-back', 'failed']),
  'rolled-back': new Set(),
  conflict: new Set(),
  failed: new Set()
};

export function createOfficeTransaction(input: {
  principalId: string;
  workSessionId: string;
  original: OfficeDocumentIdentity;
  now?: Date;
}): OfficeTransaction {
  const principalId = input.principalId.trim();
  const workSessionId = input.workSessionId.trim();
  if (!principalId || !workSessionId) throw new Error('Office transaction owner must be explicit.');
  const now = (input.now ?? new Date()).toISOString();
  return {
    version: 1, id: randomUUID(), state: 'open', principalId, workSessionId,
    original: { ...input.original }, selectedBackends: [], evidence: [], createdAt: now, updatedAt: now
  };
}

export function transitionOfficeTransaction(
  transaction: OfficeTransaction,
  next: OfficeTransactionState,
  now = new Date()
): OfficeTransaction {
  if (TERMINAL.has(transaction.state)) {
    throw new Error(`Office transaction '${transaction.id}' is terminal in state '${transaction.state}'.`);
  }
  if (!ALLOWED[transaction.state].has(next)) {
    throw new Error(`Invalid Office transaction transition '${transaction.state}' -> '${next}'.`);
  }
  return { ...transaction, state: next, updatedAt: now.toISOString() };
}

export function verifyOfficeCommitRevision(
  transaction: OfficeTransaction,
  currentOriginal: OfficeDocumentIdentity
): OfficeTransaction {
  if (transaction.state !== 'accepted') throw new Error('Office commit conflict check requires accepted state.');
  return sameOfficeDocumentRevision(transaction.original, currentOriginal)
    ? transaction
    : transitionOfficeTransaction(transaction, 'conflict');
}

export function appendOfficeTransactionBackend(
  transaction: OfficeTransaction,
  backend: OfficeBackendId
): OfficeTransaction {
  return transaction.selectedBackends.includes(backend)
    ? transaction
    : { ...transaction, selectedBackends: [...transaction.selectedBackends, backend] };
}

export function appendOfficeEvidence(
  transaction: OfficeTransaction,
  artifact: OfficeEvidenceArtifact
): OfficeTransaction {
  return { ...transaction, evidence: [...transaction.evidence, { ...artifact }] };
}

export function setOfficeValidation(
  transaction: OfficeTransaction,
  validation: OfficeValidationResult
): OfficeTransaction {
  if (transaction.state !== 'validated') throw new Error('Office validation can only be attached in validated state.');
  return { ...transaction, validation: { ...validation, assertions: validation.assertions.map(item => ({ ...item })) } };
}
