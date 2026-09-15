import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PolicyEngine } from '../policy.js';

export class HostFilesystemAdapter {
  constructor(private readonly policy: PolicyEngine) {}

  private requireAbsolute(target: string): string {
    this.policy.assertHostFilesystem();
    if (!path.isAbsolute(target)) throw new Error('Full-control host filesystem paths must be absolute.');
    return path.resolve(target);
  }

  async list(targetPath: string) {
    const target = await fs.realpath(this.requireAbsolute(targetPath));
    const entries = await fs.readdir(target, { withFileTypes: true });
    return Promise.all(entries.map(async entry => {
      const full = path.join(target, entry.name);
      try {
        const stat = await fs.lstat(full);
        return {
          name: entry.name,
          path: full,
          type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : entry.isSymbolicLink() ? 'symlink' : 'other',
          size: stat.size,
          mtime: stat.mtime.toISOString()
        };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? 'UNKNOWN';
        return {
          name: entry.name,
          path: full,
          type: 'inaccessible',
          size: null,
          mtime: null,
          error: code
        };
      }
    }));
  }

  async read(targetPath: string) {
    const target = await fs.realpath(this.requireAbsolute(targetPath));
    const stat = await fs.stat(target);
    if (!stat.isFile()) throw new Error('host_fs_read only supports regular files.');
    if (stat.size > this.policy.config.filesystem.maxReadBytes) {
      throw new Error(`File exceeds maxReadBytes (${this.policy.config.filesystem.maxReadBytes}).`);
    }
    const buffer = await fs.readFile(target);
    if (buffer.includes(0)) throw new Error('Binary files are not supported by host_fs_read.');
    return {
      path: target,
      content: buffer.toString('utf8'),
      bytes: buffer.byteLength,
      sha256: crypto.createHash('sha256').update(buffer).digest('hex')
    };
  }

  async write(targetPath: string, content: string, overwrite: boolean, expectedSha256?: string) {
    const target = this.requireAbsolute(targetPath);
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > this.policy.config.filesystem.maxWriteBytes) {
      throw new Error(`Write exceeds maxWriteBytes (${this.policy.config.filesystem.maxWriteBytes}).`);
    }

    const parent = await fs.realpath(path.dirname(target));
    const normalized = path.join(parent, path.basename(target));
    let existing: Buffer | undefined;
    try {
      const existingReal = await fs.realpath(normalized);
      const stat = await fs.stat(existingReal);
      if (!stat.isFile()) throw new Error('host_fs_write only overwrites regular files.');
      existing = await fs.readFile(existingReal);
      if (!overwrite) throw new Error('Target already exists. Set overwrite=true to replace it.');
      if (expectedSha256) {
        const currentSha = crypto.createHash('sha256').update(existing).digest('hex');
        if (currentSha.toLowerCase() !== expectedSha256.toLowerCase()) {
          throw new Error(`Concurrent modification detected: expected SHA-256 ${expectedSha256}, current ${currentSha}.`);
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw error;
      if (expectedSha256) throw new Error('Target does not exist but expectedSha256 was supplied.');
    }

    await fs.writeFile(normalized, content, { encoding: 'utf8', flag: existing ? 'w' : 'wx' });
    return {
      path: normalized,
      bytes,
      sha256: crypto.createHash('sha256').update(content).digest('hex')
    };
  }
}
