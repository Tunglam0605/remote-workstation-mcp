import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PathGuard } from '../../security/path-guard.js';
import type { ComfyUiPresetJobs } from './comfyui-jobs.js';
import type { MediaProfileStore } from './profile-store.js';

const ALLOWED_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif',
  '.mp4', '.webm', '.mov',
  '.wav', '.mp3', '.flac', '.m4a'
]);

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function safeFilename(value: string | undefined): string {
  const filename = value?.trim();
  if (!filename || filename.length > 260 || filename.includes('\0') || filename.includes('/') || filename.includes('\\')) {
    throw new Error('ComfyUI artifact filename is missing or unsafe.');
  }
  if (filename === '.' || filename === '..') throw new Error('ComfyUI artifact filename is unsafe.');
  const ext = path.extname(filename).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) throw new Error(`ComfyUI artifact extension '${ext || '(none)'}' is not allowed for project import.`);
  return filename;
}

function safeSubfolder(value: string | undefined): string {
  const subfolder = value?.trim() ?? '';
  if (!subfolder) return '';
  if (subfolder.length > 260 || subfolder.includes('\0') || path.isAbsolute(subfolder)) {
    throw new Error('ComfyUI artifact subfolder is unsafe.');
  }
  const normalized = path.normalize(subfolder);
  if (normalized === '..' || normalized.startsWith('..' + path.sep)) {
    throw new Error('ComfyUI artifact subfolder traversal is not allowed.');
  }
  return normalized === '.' ? '' : normalized;
}

function endpoint(profile: { scheme: 'http'; host: string; port: number }): string {
  const host = profile.host.includes(':') ? `[${profile.host}]` : profile.host;
  return `${profile.scheme}://${host}:${profile.port}`;
}

export class ComfyUiArtifactImporter {
  constructor(
    private readonly paths: PathGuard,
    private readonly profiles: MediaProfileStore,
    private readonly jobs: ComfyUiPresetJobs
  ) {}

  private async resolveArtifact(profileId: string, promptId: string, artifactIndex: number, timeoutMs: number) {
    if (!Number.isInteger(artifactIndex) || artifactIndex < 0 || artifactIndex > 255) {
      throw new Error('ComfyUI artifactIndex must be in range 0..255.');
    }
    const status = await this.jobs.status(profileId, promptId, timeoutMs);
    if (!status.found) throw new Error(`ComfyUI prompt '${promptId}' was not found.`);
    const artifact = status.artifacts[artifactIndex];
    if (!artifact) throw new Error(`ComfyUI artifactIndex ${artifactIndex} is not available for prompt '${promptId}'.`);
    if (artifact.type !== 'output') {
      throw new Error('Media Phase 3 imports only durable ComfyUI output artifacts.');
    }
    const filename = safeFilename(artifact.filename);
    const subfolder = safeSubfolder(artifact.subfolder);
    return {
      status,
      artifact: {
        index: artifactIndex,
        nodeId: artifact.nodeId,
        kind: artifact.kind,
        filename,
        subfolder,
        type: 'output' as const
      }
    };
  }

  private async resolveDestination(workspace: string, projectPath: string, destination: string, sourceFilename: string) {
    if (!destination || destination.length > 1024 || path.isAbsolute(destination) || destination.includes('\0')) {
      throw new Error('Media artifact destination must be a bounded path relative to the selected project root.');
    }
    const sourceExt = path.extname(sourceFilename).toLowerCase();
    const destinationExt = path.extname(destination).toLowerCase();
    if (destinationExt !== sourceExt) {
      throw new Error(`Media artifact destination extension must match source extension '${sourceExt}'.`);
    }

    const projectRoot = await this.paths.resolveExisting(workspace, projectPath);
    const destinationAbsolute = await this.paths.resolveForWrite(workspace, path.join(projectPath, destination));
    const parent = path.dirname(destinationAbsolute);
    const parentReal = await fs.realpath(parent);
    if (!inside(projectRoot, parentReal)) throw new Error('Media artifact destination parent escaped the selected project root.');

    const existing = await fs.lstat(destinationAbsolute).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    if (existing) throw new Error('Media artifact destination already exists; import never overwrites.');

    return { projectRoot, destinationAbsolute };
  }

  async plan(
    profileId: string,
    promptId: string,
    artifactIndex: number,
    workspace: string,
    projectPath: string,
    destination: string,
    timeoutMs = 5_000
  ) {
    const { status, artifact } = await this.resolveArtifact(profileId, promptId, artifactIndex, timeoutMs);
    const { destinationAbsolute } = await this.resolveDestination(workspace, projectPath, destination, artifact.filename);
    return {
      profileId,
      promptId,
      completed: status.completed,
      artifact,
      workspace,
      projectPath,
      destination,
      destinationAbsolute,
      overwritePolicy: 'fail-if-exists'
    };
  }

  async importArtifact(
    profileId: string,
    promptId: string,
    artifactIndex: number,
    workspace: string,
    projectPath: string,
    destination: string,
    options: { timeoutMs?: number; maxBytes?: number } = {}
  ) {
    const timeoutMs = options.timeoutMs ?? 60_000;
    const maxBytes = options.maxBytes ?? 512 * 1024 * 1024;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) {
      throw new Error('ComfyUI artifact import timeoutMs must be 1000..300000.');
    }
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024 * 1024) {
      throw new Error('ComfyUI artifact import maxBytes must be in range 1..1073741824.');
    }

    const { artifact } = await this.resolveArtifact(profileId, promptId, artifactIndex, Math.min(timeoutMs, 15_000));
    const { destinationAbsolute } = await this.resolveDestination(workspace, projectPath, destination, artifact.filename);
    const profile = await this.profiles.get(profileId);
    const base = endpoint(profile);

    const params = new URLSearchParams({
      filename: artifact.filename,
      subfolder: artifact.subfolder,
      type: artifact.type
    });
    const url = `${base}/view?${params.toString()}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const temp = `${destinationAbsolute}.rwmcp-${randomUUID()}.part`;
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    let handle: fs.FileHandle | undefined;
    let accepted = false;

    try {
      const response = await fetch(url, {
        method: 'GET',
        redirect: 'error',
        signal: controller.signal,
        headers: { 'user-agent': 'RemoteWorkstationMCP/0.66' }
      });
      if (!response.ok) throw new Error(`ComfyUI artifact download failed with HTTP ${response.status}.`);
      const declaredLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        throw new Error('ComfyUI artifact exceeds configured maxBytes.');
      }
      if (!response.body) throw new Error('ComfyUI artifact response had no body.');

      handle = await fs.open(temp, 'wx');
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value?.byteLength) continue;
        bytes += value.byteLength;
        if (bytes > maxBytes) throw new Error('ComfyUI artifact exceeded configured maxBytes while streaming.');
        const chunk = Buffer.from(value);
        hash.update(chunk);
        await handle.write(chunk);
      }
      await handle.sync();
      await handle.close();
      handle = undefined;
      if (bytes <= 0) throw new Error('ComfyUI artifact download was empty.');

      await fs.rename(temp, destinationAbsolute);
      accepted = true;
      return {
        profileId,
        promptId,
        artifact,
        workspace,
        projectPath,
        destination,
        bytes,
        sha256: hash.digest('hex'),
        contentType: response.headers.get('content-type')?.slice(0, 128) || undefined
      };
    } finally {
      clearTimeout(timer);
      if (handle) await handle.close().catch(() => undefined);
      if (!accepted) await fs.rm(temp, { force: true }).catch(() => undefined);
    }
  }
}
