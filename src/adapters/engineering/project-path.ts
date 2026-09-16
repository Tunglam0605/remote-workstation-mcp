import fs from 'node:fs/promises';
import path from 'node:path';
import { PathGuard } from '../../security/path-guard.js';

export async function resolveExistingProjectPath(
  paths: PathGuard,
  workspace: string,
  projectPath: string,
  childPath: string,
  label: string
): Promise<string> {
  if (path.isAbsolute(childPath)) throw new Error(`${label} must be relative to the selected project root.`);
  const projectRoot = await paths.resolveExisting(workspace, projectPath);
  const candidate = await fs.realpath(path.resolve(projectRoot, childPath));
  const relative = path.relative(projectRoot, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} cannot escape the selected project root.`);
  }
  return candidate;
}
