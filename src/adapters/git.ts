import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { PolicyEngine } from '../policy.js';
import { PathGuard } from '../security/path-guard.js';
import { buildSafeEnvironment } from '../security/env-filter.js';

const execFileAsync = promisify(execFile);

export interface GitLogEntry {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  subject: string;
}

export interface GitBranchEntry {
  name: string;
  shortHash: string;
  current: boolean;
}

export interface GitWorktreeEntry {
  path: string;
  head?: string;
  branch?: string;
  bare?: boolean;
  detached?: boolean;
  locked?: string;
  prunable?: string;
}

export class GitAdapter {
  constructor(private readonly policy: PolicyEngine, private readonly paths: PathGuard) {}

  private async repoPath(workspace: string, repoPath = '.'): Promise<string> {
    return this.paths.resolveExisting(workspace, repoPath);
  }

  private async run(workspace: string, repoPath: string, args: string[]): Promise<string> {
    const cwd = await this.repoPath(workspace, repoPath);
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      env: buildSafeEnvironment(this.policy.config.process.inheritEnv),
      timeout: 30000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true
    });
    return stdout.trimEnd();
  }

  private async validateBranchName(workspace: string, repoPath: string, branch: string): Promise<void> {
    if (!branch || branch.startsWith('-')) throw new Error('Invalid Git branch name.');
    await this.run(workspace, repoPath, ['check-ref-format', '--branch', branch]);
  }

  private async resolveCommit(workspace: string, repoPath: string, ref: string): Promise<string> {
    if (!ref || ref.startsWith('-')) throw new Error('Invalid Git start point.');
    return this.run(workspace, repoPath, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);
  }

  status(workspace: string, repoPath = '.'): Promise<string> {
    return this.run(workspace, repoPath, ['status', '--porcelain=v2', '--branch']);
  }

  diff(workspace: string, staged = false, repoPath = '.'): Promise<string> {
    return this.run(workspace, repoPath, staged ? ['diff', '--cached', '--no-ext-diff'] : ['diff', '--no-ext-diff']);
  }

  async log(workspace: string, maxEntries = 20, repoPath = '.'): Promise<GitLogEntry[]> {
    const output = await this.run(workspace, repoPath, [
      'log',
      `--max-count=${Math.max(1, Math.min(maxEntries, 200))}`,
      '--date=iso-strict',
      '--pretty=format:%H%x09%h%x09%an%x09%ad%x09%s'
    ]);
    if (!output) return [];
    return output.split(/\r?\n/).map(line => {
      const [hash = '', shortHash = '', author = '', date = '', ...subjectParts] = line.split('\t');
      return { hash, shortHash, author, date, subject: subjectParts.join('\t') };
    });
  }

  async branches(workspace: string, repoPath = '.'): Promise<GitBranchEntry[]> {
    const output = await this.run(workspace, repoPath, [
      'for-each-ref',
      '--format=%(refname:short)%09%(objectname:short)%09%(HEAD)',
      'refs/heads/'
    ]);
    if (!output) return [];
    return output.split(/\r?\n/).map(line => {
      const [name = '', shortHash = '', head = ''] = line.split('\t');
      return { name, shortHash, current: head.trim() === '*' };
    });
  }

  async add(workspace: string, files: string[], repoPath = '.'): Promise<{ added: string[] }> {
    this.policy.assertWrite(workspace);
    if (files.length === 0) throw new Error('At least one file is required.');
    for (const file of files) {
      if (path.isAbsolute(file)) throw new Error('Git paths must be repository-relative.');
      await this.paths.resolveExisting(workspace, path.join(repoPath, file));
    }
    await this.run(workspace, repoPath, ['add', '--', ...files]);
    return { added: files };
  }

  async commit(workspace: string, message: string, repoPath = '.'): Promise<{ output: string }> {
    this.policy.assertWrite(workspace);
    if (!message.trim()) throw new Error('Commit message must not be empty.');
    const output = await this.run(workspace, repoPath, ['commit', '-m', message]);
    return { output };
  }

  async createBranch(workspace: string, branch: string, startPoint = 'HEAD', repoPath = '.'): Promise<{ branch: string; startPoint: string }> {
    this.policy.assertWrite(workspace);
    await this.validateBranchName(workspace, repoPath, branch);
    const startCommit = await this.resolveCommit(workspace, repoPath, startPoint);
    await this.run(workspace, repoPath, ['branch', branch, startCommit]);
    return { branch, startPoint: startCommit };
  }

  async switchBranch(workspace: string, branch: string, repoPath = '.'): Promise<{ branch: string }> {
    this.policy.assertWrite(workspace);
    await this.validateBranchName(workspace, repoPath, branch);
    await this.run(workspace, repoPath, ['switch', branch]);
    return { branch };
  }

  async worktrees(workspace: string, repoPath = '.'): Promise<GitWorktreeEntry[]> {
    const output = await this.run(workspace, repoPath, ['worktree', 'list', '--porcelain']);
    if (!output) return [];

    return output.split(/\r?\n\r?\n/).filter(Boolean).map(block => {
      const entry: GitWorktreeEntry = { path: '' };
      for (const line of block.split(/\r?\n/)) {
        const [key, ...rest] = line.split(' ');
        const value = rest.join(' ');
        if (key === 'worktree') entry.path = value;
        else if (key === 'HEAD') entry.head = value;
        else if (key === 'branch') entry.branch = value.replace(/^refs\/heads\//, '');
        else if (key === 'bare') entry.bare = true;
        else if (key === 'detached') entry.detached = true;
        else if (key === 'locked') entry.locked = value || 'true';
        else if (key === 'prunable') entry.prunable = value || 'true';
      }
      return entry;
    });
  }

  async addWorktree(
    workspace: string,
    worktreePath: string,
    branch: string,
    options: { repoPath?: string; createBranch?: boolean; startPoint?: string } = {}
  ): Promise<{ path: string; branch: string; createdBranch: boolean }> {
    this.policy.assertWrite(workspace);
    const repoPath = options.repoPath ?? '.';
    const repo = await this.repoPath(workspace, repoPath);
    const target = await this.paths.resolveForWrite(workspace, worktreePath);
    const relativeToRepo = path.relative(repo, target);
    if (relativeToRepo === '' || (!relativeToRepo.startsWith(`..${path.sep}`) && relativeToRepo !== '..' && !path.isAbsolute(relativeToRepo))) {
      throw new Error('Worktree destination must be outside the source repository. Configure the workspace root as a common parent and use repoPath plus a sibling worktreePath.');
    }

    await this.validateBranchName(workspace, repoPath, branch);
    const args = ['worktree', 'add'];
    if (options.createBranch ?? true) {
      const startCommit = await this.resolveCommit(workspace, repoPath, options.startPoint ?? 'HEAD');
      args.push('-b', branch, target, startCommit);
    } else {
      args.push(target, branch);
    }
    await this.run(workspace, repoPath, args);
    return { path: target, branch, createdBranch: options.createBranch ?? true };
  }

  async removeWorktree(workspace: string, worktreePath: string, force = false, repoPath = '.'): Promise<{ removed: string }> {
    this.policy.assertWrite(workspace);
    const target = await this.paths.resolveExisting(workspace, worktreePath);
    const args = ['worktree', 'remove'];
    if (force) args.push('--force');
    args.push(target);
    await this.run(workspace, repoPath, args);
    return { removed: target };
  }
}
