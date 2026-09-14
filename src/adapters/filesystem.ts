import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PolicyEngine } from '../policy.js';
import { PathGuard } from '../security/path-guard.js';

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
    if (buffer.includes(0)) throw new Error('Binary files are not supported by fs_read in v0.1.');
    return {
      content: buffer.toString('utf8'),
      sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
      bytes: buffer.byteLength
    };
  }

  async write(workspace: string, relativePath: string, content: string, overwrite: boolean): Promise<{ bytes: number; sha256: string }> {
    this.policy.assertWrite(workspace);
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > this.policy.config.filesystem.maxWriteBytes) throw new Error(`Write exceeds maxWriteBytes (${this.policy.config.filesystem.maxWriteBytes}).`);
    const target = await this.paths.resolveForWrite(workspace, relativePath);
    if (!overwrite) {
      try {
        await fs.access(target);
        throw new Error('Target already exists. Set overwrite=true or use fs_patch.');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    await fs.writeFile(target, content, { encoding: 'utf8', flag: overwrite ? 'w' : 'wx' });
    return { bytes, sha256: crypto.createHash('sha256').update(content).digest('hex') };
  }

  async patch(workspace: string, relativePath: string, find: string, replace: string, expectedOccurrences = 1): Promise<{ replacements: number }> {
    this.policy.assertWrite(workspace);
    if (!find) throw new Error('find must not be empty.');
    const target = await this.paths.resolveExisting(workspace, relativePath);
    const stat = await fs.stat(target);
    if (!stat.isFile()) throw new Error('fs_patch only supports regular files.');
    if (stat.size > this.policy.config.filesystem.maxReadBytes) throw new Error('File is too large to patch.');
    const current = await fs.readFile(target, 'utf8');
    const count = current.split(find).length - 1;
    if (count !== expectedOccurrences) throw new Error(`Expected ${expectedOccurrences} occurrence(s) but found ${count}.`);
    const next = current.split(find).join(replace);
    if (Buffer.byteLength(next, 'utf8') > this.policy.config.filesystem.maxWriteBytes) throw new Error('Patched file exceeds maxWriteBytes.');
    await fs.writeFile(target, next, 'utf8');
    return { replacements: count };
  }
}
