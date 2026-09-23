import { unzipSync } from 'fflate';

export interface OoxmlPackageLimits { maxEntries: number; maxEntryBytes: number; maxExpandedBytes: number; }
export interface OoxmlPackageEntryInfo { name: string; compressedBytes: number; uncompressedBytes: number; }
export interface OoxmlPackage { entries: Map<string, Uint8Array>; manifest: OoxmlPackageEntryInfo[]; expandedBytes: number; }

export const DEFAULT_OOXML_LIMITS: OoxmlPackageLimits = {
  maxEntries: 4096,
  maxEntryBytes: 64 * 1024 * 1024,
  maxExpandedBytes: 256 * 1024 * 1024
};

const CFB_MAGIC = Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  return bytes.length >= prefix.length && prefix.every((value, index) => bytes[index] === value);
}

function safeEntryName(name: string): boolean {
  if (!name || name.includes('\0') || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) return false;
  return name.split('/').every(segment => segment !== '..' && segment !== '.');
}

function findEocd(bytes: Uint8Array): number {
  const min = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= min; offset -= 1) {
    if (u32(bytes, offset) === 0x06054b50) return offset;
  }
  throw new Error('OOXML_PACKAGE_INVALID: ZIP end-of-central-directory record was not found.');
}

export function inspectZipCentralDirectory(
  bytes: Uint8Array,
  limits: OoxmlPackageLimits = DEFAULT_OOXML_LIMITS
): OoxmlPackageEntryInfo[] {
  if (startsWith(bytes, CFB_MAGIC)) {
    throw new Error('OFFICE_ENCRYPTED_OR_LEGACY_CONTAINER: expected an OOXML ZIP package, received an OLE compound container.');
  }
  if (bytes.length < 22 || u32(bytes, 0) !== 0x04034b50) {
    throw new Error('OOXML_PACKAGE_INVALID: file is not a ZIP-based Office Open XML package.');
  }

  const eocd = findEocd(bytes);
  const disk = u16(bytes, eocd + 4);
  const centralDisk = u16(bytes, eocd + 6);
  const entriesOnDisk = u16(bytes, eocd + 8);
  const entryCount = u16(bytes, eocd + 10);
  const centralBytes = u32(bytes, eocd + 12);
  const centralOffset = u32(bytes, eocd + 16);
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) {
    throw new Error('OOXML_PACKAGE_UNSUPPORTED: multi-disk ZIP packages are not supported.');
  }
  if (entryCount === 0xffff || centralBytes === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error('OOXML_PACKAGE_UNSUPPORTED: ZIP64 packages are not supported by this bounded reader.');
  }
  if (entryCount > limits.maxEntries) throw new Error('OOXML_PACKAGE_LIMIT: package entry count exceeds configured limit.');
  if (centralOffset + centralBytes > bytes.length) throw new Error('OOXML_PACKAGE_INVALID: central directory exceeds package bounds.');

  const decoder = new TextDecoder('utf-8', { fatal: true });
  const manifest: OoxmlPackageEntryInfo[] = [];
  let offset = centralOffset;
  let expandedBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > bytes.length || u32(bytes, offset) !== 0x02014b50) {
      throw new Error('OOXML_PACKAGE_INVALID: malformed central directory.');
    }
    const flags = u16(bytes, offset + 8);
    const compressedBytes = u32(bytes, offset + 20);
    const uncompressedBytes = u32(bytes, offset + 24);
    const nameLength = u16(bytes, offset + 28);
    const extraLength = u16(bytes, offset + 30);
    const commentLength = u16(bytes, offset + 32);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    const next = nameEnd + extraLength + commentLength;
    if (next > bytes.length) throw new Error('OOXML_PACKAGE_INVALID: central entry exceeds package bounds.');
    if ((flags & 1) !== 0) throw new Error('OOXML_PACKAGE_UNSUPPORTED: encrypted ZIP entries are not permitted.');

    let name: string;
    try { name = decoder.decode(bytes.subarray(nameStart, nameEnd)); }
    catch { throw new Error('OOXML_PACKAGE_INVALID: entry name is not valid UTF-8.'); }
    if (!safeEntryName(name)) throw new Error(`OOXML_PACKAGE_INVALID: unsafe ZIP entry name '${name}'.`);
    if (uncompressedBytes > limits.maxEntryBytes) throw new Error(`OOXML_PACKAGE_LIMIT: '${name}' exceeds maxEntryBytes.`);
    expandedBytes += uncompressedBytes;
    if (expandedBytes > limits.maxExpandedBytes) throw new Error('OOXML_PACKAGE_LIMIT: expanded package exceeds configured limit.');
    manifest.push({ name, compressedBytes, uncompressedBytes });
    offset = next;
  }
  return manifest;
}

export function readOoxmlPackage(
  bytes: Uint8Array,
  limits: OoxmlPackageLimits = DEFAULT_OOXML_LIMITS
): OoxmlPackage {
  const manifest = inspectZipCentralDirectory(bytes, limits);
  const expandedBytes = manifest.reduce((sum, item) => sum + item.uncompressedBytes, 0);
  let inflated: Record<string, Uint8Array>;
  try { inflated = unzipSync(bytes); }
  catch (error) {
    throw new Error(`OOXML_PACKAGE_INVALID: ZIP inflate failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const entries = new Map<string, Uint8Array>();
  for (const item of manifest) {
    if (item.name.endsWith('/')) continue;
    const data = inflated[item.name];
    if (!data || data.byteLength !== item.uncompressedBytes) {
      throw new Error(`OOXML_PACKAGE_INVALID: inflated size mismatch for '${item.name}'.`);
    }
    entries.set(item.name, data);
  }
  return { entries, manifest, expandedBytes };
}

export function requirePackageEntry(pkg: OoxmlPackage, name: string): Uint8Array {
  const entry = pkg.entries.get(name);
  if (!entry) throw new Error(`OOXML_PACKAGE_INVALID: required part '${name}' is missing.`);
  return entry;
}
