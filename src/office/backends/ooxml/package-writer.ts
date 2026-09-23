import { zipSync } from 'fflate';
import type { OoxmlPackage } from './package-reader.js';

export function writeOoxmlPackage(
  pkg: OoxmlPackage,
  replacements: ReadonlyMap<string, Uint8Array>,
  deletions: ReadonlySet<string> = new Set()
): Uint8Array {
  const output: Record<string, Uint8Array> = {};
  for (const [name, bytes] of pkg.entries) {
    if (deletions.has(name)) continue;
    output[name] = replacements.get(name) ?? bytes;
  }
  for (const [name, bytes] of replacements) {
    if (!pkg.entries.has(name) && !deletions.has(name)) output[name] = bytes;
  }
  return zipSync(output, { level: 6 });
}
