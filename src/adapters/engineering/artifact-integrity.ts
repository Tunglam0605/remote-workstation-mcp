import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { PolicyEngine } from '../../policy.js';
import { PathGuard } from '../../security/path-guard.js';

const MAX_ARTIFACT_BYTES = 128 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set(['.elf', '.axf', '.hex', '.bin']);

export interface ArtifactManifestV1 {
  schemaVersion: 1;
  artifact: string;
  sha256: string;
  size: number;
  kind: 'elf' | 'axf' | 'hex' | 'bin';
}

export interface AcceptedArtifact extends ArtifactManifestV1 {
  verifiedPath: string;
  manifestPath: string;
  reused: boolean;
}

function assertProjectRelative(value: string): string {
  if (!value || value.length > 512) throw new Error('artifact path must contain 1..512 characters.');
  if (path.isAbsolute(value)) throw new Error('artifact path must be relative to the selected project root.');
  const segments = value.split(/[\\/]+/);
  if (segments.includes('..')) throw new Error('artifact path must not escape the selected project root.');
  return path.normalize(value);
}

function artifactKind(value: string): ArtifactManifestV1['kind'] {
  const ext = path.extname(value).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error('artifact must be an ELF, AXF, HEX or BIN firmware file.');
  }
  return ext.slice(1) as ArtifactManifestV1['kind'];
}

function normalizeSha256(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new Error('expectedSha256 must be exactly 64 hexadecimal characters.');
  return normalized;
}

async function hashFile(file: string): Promise<{ sha256: string; size: number }> {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(file)) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += data.length;
    if (size > MAX_ARTIFACT_BYTES) throw new Error(`artifact exceeds the ${MAX_ARTIFACT_BYTES} byte integrity limit.`);
    hash.update(data);
  }
  return { sha256: hash.digest('hex'), size };
}

async function copyAndHash(source: string, target: string): Promise<{ sha256: string; size: number }> {
  const hash = createHash('sha256');
  let size = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > MAX_ARTIFACT_BYTES) {
        callback(new Error(`artifact exceeds the ${MAX_ARTIFACT_BYTES} byte integrity limit.`));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    }
  });
  await pipeline(
    createReadStream(source),
    meter,
    createWriteStream(target, { flags: 'wx', mode: 0o600 })
  );
  return { sha256: hash.digest('hex'), size };
}

function portable(value: string): string {
  return value.split(path.sep).join('/');
}

export class ArtifactIntegrityAdapter {
  constructor(
    private readonly policy: PolicyEngine,
    private readonly paths: PathGuard
  ) {}

  async prepare(workspace: string, projectPath: string, artifact: string): Promise<ArtifactManifestV1> {
    this.policy.assertEngineeringEnabled();
    const relative = assertProjectRelative(artifact);
    const kind = artifactKind(relative);
    const absolute = await this.paths.resolveExisting(workspace, path.join(projectPath, relative));
    const stat = await fs.stat(absolute);
    if (!stat.isFile()) throw new Error('artifact must resolve to a regular file.');
    if (stat.size <= 0) throw new Error('artifact is empty.');
    if (stat.size > MAX_ARTIFACT_BYTES) throw new Error(`artifact exceeds the ${MAX_ARTIFACT_BYTES} byte integrity limit.`);
    const digest = await hashFile(absolute);
    return {
      schemaVersion: 1,
      artifact: portable(relative),
      sha256: digest.sha256,
      size: digest.size,
      kind
    };
  }

  async accept(options: {
    workspace: string;
    projectPath: string;
    artifact: string;
    expectedSha256: string;
    expectedSize?: number;
  }): Promise<AcceptedArtifact> {
    this.policy.assertWrite(options.workspace);
    const relative = assertProjectRelative(options.artifact);
    const kind = artifactKind(relative);
    const expectedSha256 = normalizeSha256(options.expectedSha256);
    if (options.expectedSize !== undefined && (!Number.isSafeInteger(options.expectedSize) || options.expectedSize <= 0 || options.expectedSize > MAX_ARTIFACT_BYTES)) {
      throw new Error(`expectedSize must be an integer between 1 and ${MAX_ARTIFACT_BYTES}.`);
    }

    const projectRoot = await this.paths.resolveExisting(options.workspace, options.projectPath);
    const source = await this.paths.resolveExisting(options.workspace, path.join(options.projectPath, relative));
    const sourceStat = await fs.stat(source);
    if (!sourceStat.isFile()) throw new Error('artifact must resolve to a regular file.');

    const verifiedDir = path.join(projectRoot, '.rwmcp', 'artifacts', 'verified');
    await fs.mkdir(verifiedDir, { recursive: true });
    const basename = path.basename(relative);
    const verifiedName = `${expectedSha256}-${basename}`;
    const finalAbsolute = path.join(verifiedDir, verifiedName);
    const manifestAbsolute = `${finalAbsolute}.manifest.json`;
    const tempAbsolute = path.join(verifiedDir, `.${randomUUID()}.tmp`);

    let copied: { sha256: string; size: number } | undefined;
    try {
      copied = await copyAndHash(source, tempAbsolute);
      if (copied.sha256 !== expectedSha256) {
        throw new Error(`artifact SHA-256 mismatch: expected ${expectedSha256}, got ${copied.sha256}.`);
      }
      if (options.expectedSize !== undefined && copied.size !== options.expectedSize) {
        throw new Error(`artifact size mismatch: expected ${options.expectedSize}, got ${copied.size}.`);
      }

      let reused = false;
      try {
        const existing = await hashFile(finalAbsolute);
        if (existing.sha256 !== copied.sha256 || existing.size !== copied.size) {
          throw new Error('verified artifact destination already exists with different content.');
        }
        reused = true;
        await fs.unlink(tempAbsolute);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          await fs.rename(tempAbsolute, finalAbsolute);
        } else if (error instanceof Error && error.message === 'verified artifact destination already exists with different content.') {
          throw error;
        } else if (!reused) {
          throw error;
        }
      }

      const verifiedRelative = portable(path.relative(projectRoot, finalAbsolute));
      const manifestRelative = portable(path.relative(projectRoot, manifestAbsolute));
      const manifest = {
        schemaVersion: 1,
        artifact: basename,
        sha256: copied.sha256,
        size: copied.size,
        kind,
        verifiedPath: verifiedRelative,
        acceptedAt: new Date().toISOString()
      };
      const manifestTemp = `${manifestAbsolute}.${randomUUID()}.tmp`;
      await fs.writeFile(manifestTemp, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(manifestTemp, manifestAbsolute);

      return {
        schemaVersion: 1,
        artifact: basename,
        sha256: copied.sha256,
        size: copied.size,
        kind,
        verifiedPath: verifiedRelative,
        manifestPath: manifestRelative,
        reused
      };
    } catch (error) {
      await fs.unlink(tempAbsolute).catch(() => undefined);
      throw error;
    }
  }
}
