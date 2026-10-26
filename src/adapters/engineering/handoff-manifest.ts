import * as z from 'zod/v4';

/** Conservative 32 MiB first-generation relay-friendly package ceiling (uncompressed). */
export const HANDOFF_MAX_UNPACKED_BYTES = 32 * 1024 * 1024;
export const HANDOFF_MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
export const HANDOFF_MAX_FILES = 2048;

const identifier = z.string().regex(/^[A-Za-z0-9._-]{1,128}$/);
const sha = z.string().regex(/^[a-f0-9]{64}$/);

export function validateHandoffPath(value: string): string {
  if (typeof value !== 'string' || !value || value.length > 512 || value.includes('\\') ||
      value.startsWith('/') || value.includes(':') || value.includes('\0') ||
      /[\x00-\x1f\x7f]/.test(value) ||
      value.split('/').some(segment => !segment || segment === '.' || segment === '..' ||
        /[. ]$/.test(segment) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment))) {
    throw new Error(`Handoff path is invalid or non-portable: ${String(value).slice(0, 80)}`);
  }
  const segments = value.toLowerCase().split('/');
  if (segments.some(segment => segment === '.git' || segment === '.ssh' || segment === '.env' ||
    segment.startsWith('.env.') || segment === '.npmrc' || segment === '.pypirc' ||
    segment === 'secrets' || segment === 'credentials' ||
    segment.endsWith('.pem') || segment.endsWith('.key') || segment === 'id_rsa')) {
    throw new Error('Handoff path contains an excluded credential or secret location.');
  }
  return value;
}

const fileSchema = z.object({
  relativePath: z.string(),
  bytes: z.number().int().nonnegative().max(HANDOFF_MAX_UNPACKED_BYTES),
  sha256: sha
}).strict();

const schema = z.object({
  schemaVersion: z.literal(1),
  jobId: identifier,
  sourceNodeId: identifier,
  destinationNodeId: identifier,
  sourceWorkspace: identifier,
  destinationWorkspace: identifier,
  projectId: identifier,
  sourceRevision: z.string().min(1).max(200),
  role: z.enum(['source', 'build_artifacts']),
  toolchainProfileId: identifier.optional(),
  createdAt: z.iso.datetime({ offset: true }),
  files: z.array(fileSchema).min(1).max(HANDOFF_MAX_FILES)
}).strict();

export type HandoffRole = 'source' | 'build_artifacts';
export type HandoffFile = z.infer<typeof fileSchema>;
export type HandoffManifestV1 = z.infer<typeof schema>;

export function validateHandoffManifest(value: unknown): HandoffManifestV1 {
  const manifest = schema.parse(value);
  const seen = new Set<string>();
  let bytes = 0;
  for (const file of manifest.files) {
    validateHandoffPath(file.relativePath);
    const portableKey = file.relativePath.toLocaleLowerCase('en-US');
    if (seen.has(portableKey)) throw new Error(`Duplicate handoff path: ${file.relativePath}`);
    seen.add(portableKey);
    bytes += file.bytes;
    if (bytes > HANDOFF_MAX_UNPACKED_BYTES) throw new Error('Handoff uncompressed size limit exceeded.');
  }
  return {
    ...manifest,
    files: manifest.files.map(file => ({ ...file }))
  };
}
