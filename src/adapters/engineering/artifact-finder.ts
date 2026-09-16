import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FirmwareArtifact } from '../../engineering/types.js';
import { PathGuard } from '../../security/path-guard.js';

const EXTENSIONS = new Map<string, FirmwareArtifact['kind']>([
  ['.elf', 'elf'], ['.axf', 'axf'], ['.hex', 'hex'], ['.bin', 'bin'], ['.map', 'map']
]);
const SKIP = new Set(['.git', 'node_modules', '.venv', 'managed_components']);

export class FirmwareArtifactFinder {
  constructor(private readonly paths: PathGuard) {}

  async find(workspace: string, projectPath = '.', maxFiles = 5000, maxResults = 100): Promise<FirmwareArtifact[]> {
    const root = await this.paths.resolveExisting(workspace, projectPath);
    const queue = [root];
    const results: FirmwareArtifact[] = [];
    let visited = 0;
    while (queue.length && visited < maxFiles && results.length < maxResults) {
      const current = queue.shift()!;
      let entries: Dirent[];
      try { entries = await fs.readdir(current, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (visited++ >= maxFiles || results.length >= maxResults) break;
        if (entry.isSymbolicLink()) continue;
        const absolute = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (!SKIP.has(entry.name)) queue.push(absolute);
          continue;
        }
        if (!entry.isFile()) continue;
        const kind = EXTENSIONS.get(path.extname(entry.name).toLowerCase());
        if (!kind) continue;
        try {
          const stat = await fs.stat(absolute);
          results.push({
            path: path.relative(root, absolute).replaceAll('\\', '/'),
            kind,
            size: stat.size,
            mtime: stat.mtime.toISOString()
          });
        } catch { /* disappeared */ }
      }
    }
    return results.sort((a, b) => b.mtime.localeCompare(a.mtime) || a.path.localeCompare(b.path));
  }
}
