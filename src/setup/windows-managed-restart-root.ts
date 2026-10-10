import path from 'node:path';
import { promises as fs } from 'node:fs';
import { verifyManagedSlotPath } from '../adapters/owner-update-control.js';

/**
 * A persistent Control Center can outlive the version it was launched from.
 * When managing an installed version slot, always start the verified current
 * slot instead of restarting its own stale code root.
 */
export async function resolveWindowsManagedRestartRoot(repoRoot: string, managedBase: string): Promise<string> {
  const versions = path.resolve(managedBase, 'versions');
  const relative = path.relative(versions, path.resolve(repoRoot));
  if (!/^v\d+\.\d+\.\d+(?:-dev\.\d+)?$/.test(relative) || relative !== path.basename(repoRoot)) {
    // Developers running Control Center directly from a source checkout are
    // not managed version slots: retain their explicit root.
    return repoRoot;
  }
  const currentPath = path.join(managedBase, 'current.txt');
  const slot = verifyManagedSlotPath(managedBase, await fs.readFile(currentPath, 'utf8'));
  const manifest = JSON.parse(await fs.readFile(path.join(slot.root, 'package.json'), 'utf8')) as { version?: string };
  if (manifest.version !== slot.version) {
    throw new Error('Managed current slot package version disagrees with current.txt; refusing unsafe restart.');
  }
  return slot.root;
}
