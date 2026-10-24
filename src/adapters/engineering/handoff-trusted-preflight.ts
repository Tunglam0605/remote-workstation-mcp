import crypto from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod/v4';
import { validateHandoffManifest, validateHandoffPath, HANDOFF_MAX_FILES, HANDOFF_MAX_UNPACKED_BYTES, type HandoffManifestV1 } from './handoff-manifest.js';
import type { OwnerTrustedBuildProfile } from './handoff-build-preflight.js';

const profile = z.object({
  id: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
  projectId: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
  target: z.string().min(1).max(160),
  sourceNodeId: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
  sourceRevision: z.string().min(1).max(200),
  destinationWorkspace: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
  allowed: z.boolean()
}).strict();
const registrySchema = z.object({
  schemaVersion: z.literal(1), profiles: z.array(profile).max(64)
}).strict();

/** No tool writes to this local owner-controlled registry. Incoming projects cannot supply it. */
export class OwnerHandoffBuildProfiles {
  constructor(private readonly absolutePrivatePath: string) {}

  async load(): Promise<readonly (OwnerTrustedBuildProfile & { destinationWorkspace: string })[]> {
    let handle: fs.FileHandle;
    try {
      const stat = await fs.lstat(this.absolutePrivatePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw new Error('Owner build profile registry must be a private regular file at most 64 KiB.');
      if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
        throw new Error('Owner build profile registry must not be readable or writable by group/others.');
      }
      handle = await fs.open(this.absolutePrivatePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      const opened = await handle.stat();
      if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev) throw new Error('Owner build profile registry changed while opening.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('No local owner-approved handoff build profile registry is configured.');
      throw error;
    }
    let content: string;
    try { content = await handle.readFile('utf8'); } finally { await handle.close(); }
    const parsed = registrySchema.parse(JSON.parse(content));
    const ids = new Set<string>();
    for (const entry of parsed.profiles) {
      if (ids.has(entry.id)) throw new Error('Duplicate owner-approved build profile ID.');
      ids.add(entry.id);
    }
    return parsed.profiles.filter(item => item.allowed);
  }
}

/** Verify all files right now; callers must revalidate before any later build. This function never executes imported content. */
export async function verifyAcceptedSourceSnapshot(workspaceRoot: string, acceptedRelativePath: string): Promise<HandoffManifestV1> {
  const segments = validateHandoffPath(acceptedRelativePath).split('/');
  let current = await fs.realpath(workspaceRoot);
  for (const segment of segments) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Accepted snapshot path contains symlink/reparse or non-directory.');
  }
  const manifestFile = path.join(current, 'handoff-manifest.json');
  const manifestStat = await fs.lstat(manifestFile);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 256 * 1024) throw new Error('Accepted snapshot manifest is invalid.');
  const manifest = validateHandoffManifest(JSON.parse(await fs.readFile(manifestFile, 'utf8')));
  if (manifest.role !== 'source') throw new Error('Build preflight requires source role.');
  const name = `${manifest.projectId}-${manifest.role}-${manifest.jobId}`;
  if (segments.at(-1) !== name) throw new Error('Accepted project directory does not match its manifest identity.');

  const found = new Set<string>();
  let visited = 0;
  const scan = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (++visited > HANDOFF_MAX_FILES * 12 + 1) throw new Error('Accepted snapshot has too many entries.');
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (relative !== 'handoff-manifest.json') validateHandoffPath(relative);
      const absolute = path.join(directory, entry.name);
      const stats = await fs.lstat(absolute);
      if (stats.isSymbolicLink()) throw new Error('Accepted snapshot contains symlink/reparse content.');
      if (stats.isDirectory()) await scan(absolute, relative);
      else if (stats.isFile()) found.add(relative);
      else throw new Error('Accepted snapshot contains a non-regular file.');
    }
  };
  await scan(current, '');
  const expected = new Set(['handoff-manifest.json', ...manifest.files.map(item => item.relativePath)]);
  if (found.size !== expected.size || [...found].some(item => !expected.has(item))) {
    throw new Error('Accepted snapshot contains unexpected/unlisted files or missing manifest files.');
  }
  let total = 0;
  for (const file of manifest.files) {
    const absolute = path.join(current, ...file.relativePath.split('/'));
    const before = await fs.lstat(absolute);
    if (!before.isFile() || before.isSymbolicLink() || before.size !== file.bytes) {
      throw new Error(`Accepted source file changed or became symlink/reparse: ${file.relativePath}`);
    }
    total += before.size;
    if (total > HANDOFF_MAX_UNPACKED_BYTES) throw new Error('Accepted source snapshot exceeded the size ceiling.');
    const handle = await fs.open(absolute, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || stats.ino !== before.ino || stats.dev !== before.dev || stats.size !== before.size) {
        throw new Error(`Accepted source file changed while opening: ${file.relativePath}`);
      }
      const bytes = await handle.readFile();
      if (bytes.byteLength !== file.bytes || crypto.createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
        throw new Error(`Accepted source checksum changed: ${file.relativePath}`);
      }
      const after = await handle.stat();
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error('Accepted source modified while inspecting.');
    } finally { await handle.close(); }
  }
  return manifest;
}
