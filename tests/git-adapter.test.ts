import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { GitAdapter } from '../src/adapters/git.js';
import type { PolicyConfig } from '../src/model.js';
import { PolicyEngine } from '../src/policy.js';
import { PathGuard } from '../src/security/path-guard.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd, windowsHide: true });
}

function config(root: string, mode: PolicyConfig['mode'] = 'workspace'): PolicyConfig {
  return {
    version: 1,
    mode,
    workspaces: [{ id: 'demo', root, readOnly: false }],
    filesystem: { maxReadBytes: 1024 * 1024, maxWriteBytes: 1024 * 1024 },
    process: { allowExecutables: [], inheritEnv: ['PATH', 'HOME', 'USERPROFILE', 'TMP', 'TEMP'], maxOutputBytes: 1024, maxRuntimeMs: 1000 }
  };
}

test('GitAdapter supports structured history, typed commits and sibling worktrees', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-git-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  await fs.mkdir(repo);
  await git(repo, ['init']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await git(repo, ['config', 'user.name', 'Remote Workstation Test']);
  await fs.writeFile(path.join(repo, 'README.md'), 'one\n', 'utf8');
  await git(repo, ['add', 'README.md']);
  await git(repo, ['commit', '-m', 'initial']);

  const policy = new PolicyEngine(config(root));
  const adapter = new GitAdapter(policy, new PathGuard(policy));

  const history = await adapter.log('demo', 10, 'repo');
  assert.equal(history.length, 1);
  assert.equal(history[0]?.subject, 'initial');
  const cleanStatus = await adapter.status('demo', 'repo');
  assert.match(cleanStatus, /^# branch\.oid /m);
  assert.match(cleanStatus, /^# branch\.head /m);

  await fs.writeFile(path.join(repo, 'README.md'), 'two\n', 'utf8');
  const dirtyStatus = await adapter.status('demo', 'repo');
  assert.match(dirtyStatus, /^1 \.M /m);
  await adapter.add('demo', ['README.md'], 'repo');
  await adapter.commit('demo', 'second', 'repo');
  assert.equal((await adapter.log('demo', 10, 'repo'))[0]?.subject, 'second');

  await adapter.addWorktree('demo', 'worktree-task', 'task/test', { repoPath: 'repo', createBranch: true, startPoint: 'HEAD' });
  const worktrees = await adapter.worktrees('demo', 'repo');
  assert.equal(worktrees.some(item => item.branch === 'task/test'), true);
  assert.equal(await fs.stat(path.join(root, 'worktree-task')).then(stat => stat.isDirectory()), true);

  await adapter.removeWorktree('demo', 'worktree-task', false, 'repo');
  assert.equal(await fs.stat(path.join(root, 'worktree-task')).then(() => true, () => false), false);
});

test('GitAdapter write operations obey read-only policy', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-git-ro-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  await fs.mkdir(repo);
  await git(repo, ['init']);

  const policy = new PolicyEngine(config(root, 'read_only'));
  const adapter = new GitAdapter(policy, new PathGuard(policy));
  await assert.rejects(adapter.createBranch('demo', 'blocked', 'HEAD', 'repo'), /read-only/);
});
