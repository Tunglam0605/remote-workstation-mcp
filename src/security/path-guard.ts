import fs from 'node:fs/promises';
import path from 'node:path';
import { PolicyEngine } from '../policy.js';

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export class PathGuard {
  constructor(private readonly policy: PolicyEngine) {}

  private async rootReal(workspaceId: string): Promise<string> {
    return fs.realpath(this.policy.workspace(workspaceId).root);
  }

  private rejectAbsolute(relativePath: string): void {
    if (path.isAbsolute(relativePath)) throw new Error('Paths must be relative to the authorized workspace root.');
  }

  async resolveExisting(workspaceId: string, relativePath = '.'): Promise<string> {
    this.rejectAbsolute(relativePath);
    const root = await this.rootReal(workspaceId);
    const candidate = path.resolve(root, relativePath);
    const real = await fs.realpath(candidate);
    if (!isInside(root, real)) throw new Error('Path escapes the authorized workspace.');
    return real;
  }

  async resolveForWrite(workspaceId: string, relativePath: string): Promise<string> {
    this.rejectAbsolute(relativePath);
    const root = await this.rootReal(workspaceId);
    const candidate = path.resolve(root, relativePath);
    const parent = await fs.realpath(path.dirname(candidate));
    if (!isInside(root, parent)) throw new Error('Parent path escapes the authorized workspace.');

    try {
      const existing = await fs.realpath(candidate);
      if (!isInside(root, existing)) throw new Error('Existing path escapes the authorized workspace through a symlink.');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw error;
    }
    return candidate;
  }
}
