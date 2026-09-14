import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PolicyEngine } from '../policy.js';
import { PathGuard } from '../security/path-guard.js';

function sha256(value: Buffer | string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export class FilesystemAdapter {
  constructor(private readonly policy: PolicyEngine, private readonly paths: PathGuard) {}

  async list(workspace: string, relativePath = '.'): Promise<unknown> {
    const target = await this.paths.resolveExisting(workspace, relativePath);
    const entries = await fs.readdir(target, { withFileTypes: true });
    return Promise.all(entries.map(async entry => {
      const full = path.join(target, entry.name);
      const stat = await fs.lstat(full);
      return {
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : entry.isSymbolicLink() ? 'symlink' : 'other',
        size: stat.size,
        mtime: stat.mtime.toISOString()
      };
    }));
  }

  async read(workspace: string, relativePath: string): Promise<{ content: string; sha256: string; bytes: number }> {
    const target = await this.paths.resolveExisting(workspace, relativePath);
    const stat = await fs.stat(target);
    if (!stat.isFile()) throw new Error('fs_read only supports regular files.');
    if (stat.size > this.policy.config.filesystem.maxReadBytes) throw new Error(`File exceeds maxReadBytes (${this.policy.config.filesystem.maxReadBytes}).`);
    const buffer = await fs.readFile(target);
    if (buffer.includes(0)) throw new Error('Binary files are not supported by fs_read.');
    return { content: buffer.toString('utf8'), sha256: sha256(buffer), bytes: buffer.byteLength };
  }

  async write(workspace: string, relativePath: string, content: string, overwrite: boolean, expectedSha256?: string): Promise<{ bytes: number; sha256: string }> {
    this.policy.assertWrite(workspace);
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > this.policy.config.filesystem.maxWriteBytes) throw new Error(`Write exceeds maxWriteBytes (${this.policy.config.filesystem.maxWriteBytes}).`);
    const target = await this.paths.resolveForWrite(workspace, relativePath);

    let exists = false;
    try {
      await fs.access(target);
      exists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    if (exists && !overwrite) throw new Error('Target already exists. Set overwrite=true or use fs_patch.');
    if (expectedSha256) {
      if (!exists) throw new Error('Concurrency conflict: target does not exist for expectedSha256 validation.');
      const current = await fs.readFile(target);
      const currentSha = sha256(current);
      if (currentSha !== expectedSha256) throw new Error(`Concurrency conflict: expected SHA-256 ${expectedSha256} but current file is ${currentSha}.`);
    }

    await fs.writeFile(target, content, { encoding: 'utf8', flag: overwrite ? 'w' : 'wx' });
    return { bytes, sha256: sha256(content) };
  }

  async patch(workspace: string, relativePath: string, find: string, replace: string, expectedOccurrences = 1, expectedSha256?: string): Promise<{ replacements: number; sha256: string }> {
    this.policy.assertWrite(workspace);
    if (!find) throw new Error('find must not be empty.');
    const target = await this.paths.resolveExisting(workspace, relativePath);
    const stat = await fs.stat(target);
    if (!stat.isFile()) throw new Error('fs_patch only supports regular files.');
    if (stat.size > this.policy.config.filesystem.maxReadBytes) throw new Error('File is too large to patch.');
    const currentBuffer = await fs.readFile(target);
    const currentSha = sha256(currentBuffer);
    if (expectedSha256 && currentSha !== expectedSha256) {
      throw new Error(`Concurrency conflict: expected SHA-256 ${expectedSha256} but current file is ${currentSha}.`);
    }
    const current = currentBuffer.toString('utf8');
    const count = current.split(find).length - 1;
    if (count !== expectedOccurrences) throw new Error(`Expected ${expectedOccurrences} occurrence(s) but found ${count}.`);
    const next = current.split(find).join(replace);
    if (Buffer.byteLength(next, 'utf8') > this.policy.config.filesystem.maxWriteBytes) throw new Error('Patched file exceeds maxWriteBytes.');
    await fs.writeFile(target, next, 'utf8');
    return { replacements: count, sha256: sha256(next) };
  }
}
