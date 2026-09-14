import fs from 'node:fs/promises';
import path from 'node:path';
import { PolicyEngine } from '../policy.js';
import { PathGuard } from '../security/path-guard.js';

interface WalkEntry {
  absolute: string;
  relative: string;
  size: number;
}

export class SearchAdapter {
  constructor(private readonly policy: PolicyEngine, private readonly paths: PathGuard) {}

  private limits() {
    return {
      maxResults: this.policy.config.search?.maxResults ?? 100,
      maxFiles: this.policy.config.search?.maxFiles ?? 5000,
      maxFileBytes: this.policy.config.search?.maxFileBytes ?? Math.min(this.policy.config.filesystem.maxReadBytes, 1024 * 1024)
    };
  }

  private async walk(workspace: string, relativePath: string): Promise<WalkEntry[]> {
    const start = await this.paths.resolveExisting(workspace, relativePath);
    const root = await fs.realpath(this.policy.workspace(workspace).root);
    const queue = [start];
    const files: WalkEntry[] = [];
    let visited = 0;
    const { maxFiles } = this.limits();

    while (queue.length > 0 && visited < maxFiles) {
      const current = queue.shift()!;
      const entries = await fs.readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        if (visited++ >= maxFiles) break;
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        const absolute = path.join(current, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          queue.push(absolute);
          continue;
        }
        if (!entry.isFile()) continue;
        const stat = await fs.stat(absolute);
        files.push({ absolute, relative: path.relative(root, absolute), size: stat.size });
      }
    }
    return files;
  }

  async findFiles(workspace: string, query: string, relativePath = '.', maxResults?: number) {
    const needle = query.toLowerCase();
    const limit = Math.min(Math.max(maxResults ?? this.limits().maxResults, 1), this.limits().maxResults);
    const files = await this.walk(workspace, relativePath);
    return files
      .filter(file => path.basename(file.relative).toLowerCase().includes(needle) || file.relative.toLowerCase().includes(needle))
      .slice(0, limit)
      .map(file => ({ path: file.relative, bytes: file.size }));
  }

  async searchText(workspace: string, query: string, relativePath = '.', caseSensitive = false, maxResults?: number) {
    if (!query) throw new Error('query must not be empty.');
    const { maxFileBytes, maxResults: configuredMax } = this.limits();
    const limit = Math.min(Math.max(maxResults ?? configuredMax, 1), configuredMax);
    const needle = caseSensitive ? query : query.toLowerCase();
    const files = await this.walk(workspace, relativePath);
    const matches: Array<{ path: string; line: number; column: number; preview: string }> = [];

    for (const file of files) {
      if (matches.length >= limit) break;
      if (file.size > maxFileBytes) continue;
      const buffer = await fs.readFile(file.absolute);
      if (buffer.includes(0)) continue;
      const lines = buffer.toString('utf8').split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const haystack = caseSensitive ? lines[index] : lines[index].toLowerCase();
        const column = haystack.indexOf(needle);
        if (column < 0) continue;
        matches.push({
          path: file.relative,
          line: index + 1,
          column: column + 1,
          preview: lines[index].slice(0, 500)
        });
        if (matches.length >= limit) break;
      }
    }
    return matches;
  }
}
