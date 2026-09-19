import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { GitAdapter } from '../src/adapters/git.js';
import { ConcurrencyPolicy } from '../src/concurrency-policy.js';
import type { PolicyConfig } from '../src/model.js';
import { PolicyEngine } from '../src/policy.js';
import { PathGuard } from '../src/security/path-guard.js';
import { WorkSessionStore } from '../src/work-session.js';
import { WorktreeManager } from '../src/worktree-manager.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd, windowsHide: true });
}

function config(root: string): PolicyConfig {
  return {
    version: 1,
    mode: 'workspace',
    workspaces: [{ id: 'demo', root, readOnly: false }],
    filesystem: { maxReadBytes: 1024 * 1024, maxWriteBytes: 1024 * 1024 },
    process: { allowExecutables: [], inheritEnv: ['PATH', 'HOME', 'USERPROFILE', 'TMP', 'TEMP'], maxOutputBytes: 1024, maxRuntimeMs: 1000 }
  };
}

test('two writable Work Sessions on the same repo receive isolated sibling worktrees', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-worktree-manager-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

  const repo = path.join(root, 'repo');
  await fs.mkdir(repo);
  await git(repo, ['init']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await git(repo, ['config', 'user.name', 'Remote Workstation Test']);
  await fs.writeFile(path.join(repo, 'README.md'), 'base\n', 'utf8');
  await git(repo, ['add', 'README.md']);
  await git(repo, ['commit', '-m', 'initial']);

  const policy = new PolicyEngine(config(root));
  const adapter = new GitAdapter(policy, new PathGuard(policy));
  const store = new WorkSessionStore('openai-tunnel', { file: path.join(root, 'sessions.json') });
  const manager = new WorktreeManager(adapter, store);
  const sessionA = await store.create({ name: 'A', workspace: 'demo', projectPath: 'repo' });
  const sessionB = await store.create({ name: 'B', workspace: 'demo', projectPath: 'repo' });

  const a = await manager.prepare(sessionA.id, { workspace: 'demo' });
  const b = await manager.prepare(sessionB.id, { workspace: 'demo' });

  assert.notEqual(a.worktreePath, b.worktreePath);
  assert.notEqual(a.branch, b.branch);
  assert.notEqual(a.buildDir, b.buildDir);
  assert.equal(a.buildDir, path.join(a.worktreePath!, 'build'));
  assert.equal(b.buildDir, path.join(b.worktreePath!, 'build'));
  assert.equal(a.reused, false);
  assert.equal(b.reused, false);
  assert.equal(await fs.stat(path.join(root, a.worktreePath!)).then(s => s.isDirectory()), true);
  assert.equal(await fs.stat(path.join(root, b.worktreePath!)).then(s => s.isDirectory()), true);

  const aAgain = await manager.prepare(sessionA.id, { workspace: 'demo' });
  assert.equal(aAgain.reused, true);
  assert.equal(aAgain.worktreePath, a.worktreePath);

  await fs.writeFile(path.join(root, a.worktreePath!, 'README.md'), 'dirty\n', 'utf8');
  const blocked = await manager.cleanup(sessionA.id);
  assert.equal(blocked.cleanupState, 'needs-owner-or-explicit-action');
  assert.equal(blocked.dirty, true);
  assert.match(blocked.reason ?? '', /NEEDS_OWNER_OR_EXPLICIT_ACTION/);
  assert.equal(await fs.stat(path.join(root, a.worktreePath!)).then(() => true, () => false), true);

  await store.beginClose(sessionB.id);
  assert.equal((await store.completeClose(sessionB.id)).status, 'closed');
  const cleaned = await manager.cleanup(sessionB.id);
  assert.equal(cleaned.cleanupState, 'removed');
  assert.equal(await fs.stat(path.join(root, b.worktreePath!)).then(() => true, () => false), false);
});

test('explicit cleanup removes a clean worktree after Work Session expiry', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-worktree-expired-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

  const repo = path.join(root, 'repo');
  await fs.mkdir(repo);
  await git(repo, ['init']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await git(repo, ['config', 'user.name', 'Remote Workstation Test']);
  await fs.writeFile(path.join(repo, 'README.md'), 'base\n', 'utf8');
  await git(repo, ['add', 'README.md']);
  await git(repo, ['commit', '-m', 'initial']);

  let now = new Date('2026-09-19T13:00:00.000Z');
  const policy = new PolicyEngine(config(root));
  const store = new WorkSessionStore('openai-tunnel', {
    file: path.join(root, 'sessions.json'),
    now: () => now
  });
  const manager = new WorktreeManager(new GitAdapter(policy, new PathGuard(policy)), store);
  const session = await store.create({
    workspace: 'demo',
    projectPath: 'repo',
    expireAfterMinutes: 1
  });
  const prepared = await manager.prepare(session.id, { workspace: 'demo' });
  assert.equal(prepared.dirty, false);

  now = new Date('2026-09-19T13:02:00.000Z');
  await store.reconcileLifecycle();
  assert.equal((await store.resume(session.id)).status, 'expired');

  const cleaned = await manager.cleanup(session.id);
  assert.equal(cleaned.cleanupState, 'removed');
  assert.equal(await fs.stat(path.join(root, prepared.worktreePath!)).then(() => true, () => false), false);
  assert.equal((await store.resume(session.id)).status, 'expired');
});

test('worktree manager fails closed when the authorized workspace root is the repository root', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-worktree-boundary-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  await git(root, ['init']);
  await git(root, ['config', 'user.email', 'test@example.com']);
  await git(root, ['config', 'user.name', 'Remote Workstation Test']);
  await fs.writeFile(path.join(root, 'README.md'), 'base\n', 'utf8');
  await git(root, ['add', 'README.md']);
  await git(root, ['commit', '-m', 'initial']);

  const policy = new PolicyEngine(config(root));
  const store = new WorkSessionStore('openai-tunnel', { file: path.join(root, '.sessions.json') });
  const manager = new WorktreeManager(new GitAdapter(policy, new PathGuard(policy)), store);
  const session = await store.create({ workspace: 'demo', projectPath: '.' });

  await assert.rejects(
    manager.prepare(session.id, { workspace: 'demo' }),
    /WORKTREE_WORKSPACE_BOUNDARY/
  );
});

test('concurrency policy classifies shared, isolated, exclusive and owner-local operations without a global lock', () => {
  const policy = new ConcurrencyPolicy();
  assert.equal(policy.classify('filesystem.read').class, 'shared');
  assert.equal(policy.classify('source.edit').class, 'session-isolated');
  assert.equal(policy.classify('hardware.debug-probe').class, 'resource-exclusive');
  assert.equal(policy.classify('build.keil-shared-output').class, 'project-variant-exclusive');
  assert.equal(policy.classify('node.update').class, 'node-exclusive');
  assert.equal(policy.classify('owner.security-grants').class, 'owner-local-only');
});
