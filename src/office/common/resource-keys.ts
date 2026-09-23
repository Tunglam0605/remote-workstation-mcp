import type { OfficeDomain } from './contracts.js';
import { normalizeCanonicalOfficePath } from './document-identity.js';

export function officeFileResourceKey(canonicalPath: string, platform = process.platform): string {
  return `office-file:${normalizeCanonicalOfficePath(canonicalPath, platform)}`;
}

export function officeDomainResourceKey(domain: OfficeDomain, canonicalPath: string, platform = process.platform): string {
  return `office-${domain}:${normalizeCanonicalOfficePath(canonicalPath, platform)}`;
}
