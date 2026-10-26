import crypto from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { strToU8, strFromU8, unzipSync, zipSync, type Zippable } from 'fflate';
import {
  HANDOFF_MAX_ARCHIVE_BYTES,
  HANDOFF_MAX_FILES,
  HANDOFF_MAX_UNPACKED_BYTES,
  validateHandoffManifest,
  validateHandoffPath,
  type HandoffManifestV1,
  type HandoffRole
} from './handoff-manifest.js';

type HandoffDraft = Omit<HandoffManifestV1, 'files'>;
const sha256 = (value: Uint8Array) => crypto.createHash('sha256').update(value).digest('hex');
const stableZipTime = new Date('2000-01-01T00:00:00Z');

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return !relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function ensureNoSymlinkSegments(root: string, relative: string, allowMissingLeaf = false): Promise<string> {
  const pieces = relative === '.' ? [] : validateHandoffPath(relative).split('/');
  const actualRoot = await fs.realpath(root);
  let candidate = actualRoot;
  for (const [index, segment] of pieces.entries()) {
    candidate = path.join(candidate, segment);
    if (!isInside(actualRoot, candidate)) throw new Error('Handoff path escapes workspace.');
    try {
      const stats = await fs.lstat(candidate);
      if (stats.isSymbolicLink()) throw new Error('Handoff symlink/reparse path is prohibited.');
      if (index < pieces.length - 1 && !stats.isDirectory()) throw new Error('Handoff parent path must be a directory.');
    } catch (error) {
      if (allowMissingLeaf && index === pieces.length - 1 && (error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
  }
  return candidate;
}

async function rejectExists(candidate: string): Promise<void> {
  try {
    await fs.lstat(candidate);
    throw new Error('Handoff destination already exists (fail-if-exists conflict).');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export interface PackageHandoffOptions {
  workspaceRoot: string;
  projectRelativePath: string;
  manifestDraft: HandoffDraft;
  outputRelativePath: string;
  includedFiles: string[];
}

export async function packageHandoff(options: PackageHandoffOptions): Promise<{
  relativePath: string; sha256: string; bytes: number; manifest: HandoffManifestV1
}> {
  const project = await ensureNoSymlinkSegments(options.workspaceRoot, options.projectRelativePath);
  const output = await ensureNoSymlinkSegments(options.workspaceRoot, options.outputRelativePath, true);
  if (!options.outputRelativePath.toLowerCase().endsWith('.zip')) throw new Error('Handoff output must be a .zip archive.');
  await rejectExists(output);
  if (!Array.isArray(options.includedFiles) || options.includedFiles.length < 1 || options.includedFiles.length > HANDOFF_MAX_FILES) {
    throw new Error('Handoff requires a bounded explicit file list.');
  }
  const names = [...options.includedFiles].sort();
  const bytesByName = new Map<string, Uint8Array>();
  let total = 0;
  for (const relativePath of names) {
    validateHandoffPath(relativePath);
    const file = await ensureNoSymlinkSegments(project, relativePath);
    if (!isInside(project, file)) throw new Error('Handoff source path escapes selected project.');
    const before = await fs.lstat(file);
    if (!before.isFile()) throw new Error('Handoff accepts only regular source files.');
    total += before.size;
    if (total > HANDOFF_MAX_UNPACKED_BYTES) throw new Error('Handoff source package size limit exceeded.');
    const handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    let bytes: Buffer;
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
        throw new Error('Handoff source changed or became symlink/reparse before opening.');
      }
      bytes = await handle.readFile();
      const atClose = await handle.stat();
      if (opened.size !== atClose.size || opened.mtimeMs !== atClose.mtimeMs) {
        throw new Error('Handoff source changed while being read.');
      }
    } finally {
      await handle.close();
    }
    const after = await fs.lstat(file);
    if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino ||
      before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.byteLength !== before.size) {
      throw new Error('Handoff source changed during packaging; retry after a stable snapshot.');
    }
    bytesByName.set(relativePath, bytes);
  }
  const manifest = validateHandoffManifest({
    ...options.manifestDraft,
    files: names.map(relativePath => ({
      relativePath, bytes: bytesByName.get(relativePath)!.byteLength,
      sha256: sha256(bytesByName.get(relativePath)!)
    }))
  });
  const entries: Zippable = {
    'manifest.json': [strToU8(JSON.stringify(manifest)), { mtime: stableZipTime }]
  };
  for (const name of names) entries[`files/${name}`] = [bytesByName.get(name)!, { mtime: stableZipTime }];
  // v1 deliberately stores entries without DEFLATE. This turns archive limits
  // into real byte limits and eliminates decompression-bomb amplification.
  const archive = zipSync(entries, { level: 0, mtime: stableZipTime });
  if (archive.byteLength > HANDOFF_MAX_ARCHIVE_BYTES) throw new Error('Handoff archive is too large for the bounded relay package.');
  // Write a fully synced private sibling first; hard-link publishes the completed
  // inode atomically and fails rather than replacing an existing destination.
  const stagingArchive = `${output}.${crypto.randomUUID()}.tmp`;
  const handle = await fs.open(stagingArchive, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(archive);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.link(stagingArchive, output);
  } finally {
    await fs.rm(stagingArchive, { force: true }).catch(() => {});
  }
  return { relativePath: options.outputRelativePath, sha256: sha256(archive), bytes: archive.byteLength, manifest };
}

export interface AcceptHandoffOptions {
  workspaceRoot: string;
  archiveRelativePath: string;
  expectedSha256: string;
  destinationRelativeBase: string;
  expectedRole: HandoffRole;
  expectedDestinationNodeId: string;
  expectedDestinationWorkspace: string;
  expectedSourceNodeId: string;
  expectedProjectId: string;
  expectedJobId: string;
  /** Rerun consent + owner bilateral destination-grant verification immediately before final rename. */
  beforePromote?: (validated: { manifest: HandoffManifestV1; sha256: string; bytes: number }) => Promise<void>;
}

export async function acceptHandoff(options: AcceptHandoffOptions): Promise<{
  acceptedPath: string; manifest: HandoffManifestV1; sha256: string
}> {
  if (!/^[a-f0-9]{64}$/.test(options.expectedSha256)) throw new Error('Expected archive SHA-256 digest is invalid.');
  const source = await ensureNoSymlinkSegments(options.workspaceRoot, options.archiveRelativePath);
  const sourceStat = await fs.lstat(source);
  if (!sourceStat.isFile() || sourceStat.size > HANDOFF_MAX_ARCHIVE_BYTES) {
    throw new Error('Handoff input archive must be a bounded regular file.');
  }
  const bytes = await fs.readFile(source);
  const archiveDigest = sha256(bytes);
  if (archiveDigest !== options.expectedSha256) throw new Error('Handoff archive checksum mismatch.');

  const archiveEntryNames = new Set<string>();
  let totalInflated = 0;
  const entries = unzipSync(bytes, { filter: entry => {
    if (entry.compression !== 0) throw new Error('Handoff archive prohibits compressed entries to prevent decompression bombs.');
    if (entry.size !== entry.originalSize) throw new Error('Stored Handoff ZIP entry has forged compressed/uncompressed size metadata.');
    if (entry.name !== 'manifest.json' && !entry.name.startsWith('files/')) throw new Error('Handoff archive contains an unknown entry.');
    if (entry.name !== 'manifest.json') validateHandoffPath(entry.name.slice('files/'.length));
    const key = entry.name.toLocaleLowerCase('en-US');
    if (archiveEntryNames.has(key)) throw new Error('Handoff archive contains a duplicate entry.');
    archiveEntryNames.add(key);
    if (archiveEntryNames.size > HANDOFF_MAX_FILES + 1) throw new Error('Handoff archive entry count exceeded.');
    totalInflated += entry.size;
    if (entry.originalSize > HANDOFF_MAX_UNPACKED_BYTES || totalInflated > HANDOFF_MAX_UNPACKED_BYTES + 256 * 1024) {
      throw new Error('Handoff archive contains an oversized/decompression-bomb entry.');
    }
    return true;
  } });
  if (Object.values(entries).reduce((sum, entry) => sum + entry.byteLength, 0) > HANDOFF_MAX_UNPACKED_BYTES + 256 * 1024) {
    throw new Error('Handoff decoded archive exceeds the fixed size ceiling.');
  }
  const manifestBytes = entries['manifest.json'];
  if (!manifestBytes || manifestBytes.byteLength > 256 * 1024) throw new Error('Handoff manifest is missing or too large.');
  const manifest = validateHandoffManifest(JSON.parse(strFromU8(manifestBytes)));
  if (manifest.role !== options.expectedRole) throw new Error('Handoff role does not match the expected project transfer.');
  if (manifest.destinationNodeId !== options.expectedDestinationNodeId ||
      manifest.destinationWorkspace !== options.expectedDestinationWorkspace ||
      manifest.sourceNodeId !== options.expectedSourceNodeId ||
      manifest.projectId !== options.expectedProjectId ||
      manifest.jobId !== options.expectedJobId) {
    throw new Error('Handoff expected node, workspace, project or job identity does not match.');
  }
  if (archiveEntryNames.size !== manifest.files.length + 1) throw new Error('Handoff archive/manifest entries differ.');
  for (const file of manifest.files) {
    const data = entries[`files/${file.relativePath}`];
    if (!data || data.byteLength !== file.bytes || sha256(data) !== file.sha256) {
      throw new Error(`Handoff file size/checksum differs from manifest: ${file.relativePath}`);
    }
  }

  const parent = await ensureNoSymlinkSegments(options.workspaceRoot, options.destinationRelativeBase);
  const acceptedName = `${manifest.projectId}-${manifest.role}-${manifest.jobId}`;
  const target = await ensureNoSymlinkSegments(parent, acceptedName, true);
  await rejectExists(target);
  const stage = await fs.mkdtemp(path.join(parent, '.rwmcp-handoff-stage-'));
  try {
    for (const file of manifest.files) {
      const targetFile = path.join(stage, ...file.relativePath.split('/'));
      await fs.mkdir(path.dirname(targetFile), { recursive: true });
      await fs.writeFile(targetFile, entries[`files/${file.relativePath}`]!, { flag: 'wx', mode: 0o600 });
    }
    await fs.writeFile(path.join(stage, 'handoff-manifest.json'), JSON.stringify(manifest), { flag: 'wx', mode: 0o600 });
    await options.beforePromote?.({ manifest, sha256: archiveDigest, bytes: bytes.byteLength });
    await rejectExists(target);
    await fs.rename(stage, target);
  } catch (error) {
    await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  const acceptedPath = path.posix.join(options.destinationRelativeBase, acceptedName);
  return { acceptedPath, manifest, sha256: archiveDigest };
}
