import { createHash } from 'node:crypto';
import path from 'node:path';

export interface OfficeDocumentIdentity {
  canonicalPath: string;
  sha256: string;
  sizeBytes: number;
  modifiedTimeMs?: number;
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function normalizeCanonicalOfficePath(value: string, platform = process.platform): string {
  if (!value.trim() || value.includes('\0')) throw new Error('Office document path must be non-empty and contain no NUL.');
  const normalized = path.resolve(value);
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function createOfficeDocumentIdentity(input: {
  canonicalPath: string;
  bytes: Uint8Array;
  modifiedTimeMs?: number;
}): OfficeDocumentIdentity {
  if (input.modifiedTimeMs !== undefined && !Number.isFinite(input.modifiedTimeMs)) {
    throw new Error('modifiedTimeMs must be finite when supplied.');
  }
  return {
    canonicalPath: normalizeCanonicalOfficePath(input.canonicalPath),
    sha256: sha256Bytes(input.bytes),
    sizeBytes: input.bytes.byteLength,
    ...(input.modifiedTimeMs !== undefined ? { modifiedTimeMs: input.modifiedTimeMs } : {})
  };
}

export function sameOfficeDocumentRevision(
  left: Pick<OfficeDocumentIdentity, 'canonicalPath' | 'sha256'>,
  right: Pick<OfficeDocumentIdentity, 'canonicalPath' | 'sha256'>
): boolean {
  return left.canonicalPath === right.canonicalPath && left.sha256 === right.sha256;
}
