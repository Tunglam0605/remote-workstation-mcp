import type { CrossNodeTransferIntent } from './multi-node-authorization.js';
import { createHash } from 'node:crypto';
import type { HandoffManifestV1 } from '../adapters/engineering/handoff-manifest.js';

/**
 * Receiver-runtime provenance for completed authenticated cross-node transfers.
 * This is deliberately NOT written into the owner-writable project workspace.
 * A receiver restart drops all proofs, requiring a fresh transfer/owner approval.
 */
export interface VerifiedCrossNodeReceipt {
  authorization: CrossNodeTransferIntent;
  verifiedPath: string;
}

interface ReceiptLedgerOptions {
  now?: () => number;
  ttlMs?: number;
}

const MAX_RECEIPTS = 256;
const MAX_RECEIPT_AGE_MS = 4 * 60 * 60 * 1000;

function receiptKey(receipt: VerifiedCrossNodeReceipt): string {
  const intent = receipt.authorization;
  if (!/^[a-f0-9]{64}$/.test(intent.sha256 ?? '') ||
    !Number.isSafeInteger(intent.size) || intent.size <= 0 ||
    !/^\.rwmcp\/transfers\/verified\/[a-f0-9]{64}-[A-Za-z0-9._-]+$/.test(receipt.verifiedPath) ||
    !receipt.verifiedPath.startsWith(`.rwmcp/transfers/verified/${intent.sha256}-`) ||
    !receipt.verifiedPath.endsWith(`-${intent.destinationFileName}`)) {
    throw new Error('Cross-node transfer receipt identity/verified path is invalid.');
  }
  return JSON.stringify([
    intent.grantId, intent.sourceNodeId, intent.destinationNodeId,
    intent.sourceWorkspace, intent.destinationWorkspace, intent.sourcePath,
    intent.destinationBasePath, intent.destinationFileName,
    intent.size, intent.sha256, intent.transport, receipt.verifiedPath
  ]);
}

export class CrossNodeReceiptLedger {
  private readonly receipts = new Map<string, number>();
  private readonly imports = new Map<string, number>();
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(options: ReceiptLedgerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = Math.max(1, Math.min(options.ttlMs ?? MAX_RECEIPT_AGE_MS, MAX_RECEIPT_AGE_MS));
  }

  /** Call ONLY after the receiver has finished a ticket-bound direct or authorized relay transfer. */
  recordReceived(receipt: VerifiedCrossNodeReceipt): void {
    const key = receiptKey(receipt);
    const now = this.now();
    this.removeExpired(now);
    if (!this.receipts.has(key) && this.receipts.size >= MAX_RECEIPTS) {
      const oldest = this.receipts.keys().next().value;
      if (oldest !== undefined) this.receipts.delete(oldest);
    }
    this.receipts.set(key, now + this.ttlMs);
  }

  assertReceived(receipt: VerifiedCrossNodeReceipt): void {
    const key = receiptKey(receipt);
    const now = this.now();
    this.removeExpired(now);
    if (!this.receipts.has(key)) {
      throw new Error('No authenticated receiver-runtime transfer receipt; forged/stale workspace sidecars are not trusted.');
    }
  }

  /** This proof is written only by the receiver's verified handoff workflow after successful publication. */
  recordImported(options: { workspace: string; acceptedPath: string; manifest: HandoffManifestV1 }): void {
    this.removeExpired(this.now());
    const key = this.importKey(options);
    if (!this.imports.has(key) && this.imports.size >= MAX_RECEIPTS) {
      const oldest = this.imports.keys().next().value;
      if (oldest !== undefined) this.imports.delete(oldest);
    }
    this.imports.set(key, this.now() + this.ttlMs);
  }

  assertImported(options: { workspace: string; acceptedPath: string; manifest: HandoffManifestV1 }): void {
    this.removeExpired(this.now());
    if (!this.imports.has(this.importKey(options))) {
      throw new Error('No authenticated receiver-runtime accepted-handoff provenance for this project snapshot.');
    }
  }

  private importKey(options: { workspace: string; acceptedPath: string; manifest: HandoffManifestV1 }): string {
    const manifestHash = createHash('sha256').update(JSON.stringify(options.manifest)).digest('hex');
    return JSON.stringify([options.workspace, options.acceptedPath, manifestHash]);
  }

  private removeExpired(now: number): void {
    for (const [key, expiresAt] of this.receipts) {
      if (expiresAt <= now) this.receipts.delete(key);
    }
    for (const [key, expiresAt] of this.imports) {
      if (expiresAt <= now) this.imports.delete(key);
    }
  }
}
