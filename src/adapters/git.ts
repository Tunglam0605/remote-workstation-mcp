import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PolicyEngine } from '../policy.js';
import { PathGuard } from '../security/path-guard.js';
import { buildSafeEnvironment } from '../security/env-filter.js';

const execFileAsync = promisify(execFile);

export class GitAdapter {
  constructor(private readonly policy: PolicyEngine, private readonly paths: PathGuard) {}

  private async run(workspace: string, args: string[]): Promise<string> {
    const cwd = await this.paths.resolveExisting(workspace, '.');
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      env: buildSafeEnvironment(this.policy.config.process.inheritEnv),
      timeout: 30000,
      maxBuffer: 1024 * 1024,
      windowsHide: true
    });
    return stdout.trimEnd();
  }

  status(workspace: string): Promise<string> {
    return this.run(workspace, ['status', '--short', '--branch']);
  }

  diff(workspace: string, staged = false): Promise<string> {
    return this.run(workspace, staged ? ['diff', '--cached', '--no-ext-diff'] : ['diff', '--no-ext-diff']);
  }
}
