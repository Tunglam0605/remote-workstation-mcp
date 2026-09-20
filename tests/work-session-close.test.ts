import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WorkSessionLifecycleService, type WorkSessionRuntimeResourceState } from '../src/work-session-lifecycle.js';
import { WorkSessionStore } from '../src/work-session.js';
import type { WorktreeManager, WorktreeState } from '../src/worktree-manager.js';

const emptyRuntime = (): WorkSessionRuntimeResourceState => ({
  processes: 0,
  terminals: 0,
  serialSessions: 0,
  debugSessions: 0,
  hardwareLeases: 0,
  nodeInterlocks: 0
});

function fakeWorktrees(state: WorktreeState): WorktreeManager {
  return {
    status: async () => state
  } as unknown as WorktreeManager;
}

test('close fails closed on owned runtime resources and never stops or releases them', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-phase3h-close-resource-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const store = new WorkSessionStore('openai-tunnel', { file: path.join(root, 'sessions.json') });
  const session = await store.create();
  await store.touch(session.id);

  const runtime = { ...emptyRuntime(), hardwareLeases: 1 };
  const service = new WorkSessionLifecycleService(
    store,
    fakeWorktrees({ sessionId: session.id, workspace: '', repoPath: '.', dirty: false }),
    async () => runtime
  );

  const result = await service.close(session.id);
  assert.equal(result.state, 'needs-owner-or-explicit-action');
  assert.equal(result.cleanupPerformed, false);
  assert.equal(result.runtime.hardwareLeases, 1);
  assert.match(result.reason ?? '', /NEEDS_OWNER_OR_EXPLICIT_ACTION/);
  assert.equal(result.session.status, 'active');
});

test('close fails closed on a dirty worktree and leaves it intact for explicit owner action', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-phase3h-close-dirty-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const store = new WorkSessionStore('openai-tunnel', { file: path.join(root, 'sessions.json') });
  const session = await store.create({ workspace: 'demo' });
  await store.touch(session.id);

  const worktree: WorktreeState = {
    sessionId: session.id,
    workspace: 'demo',
    repoPath: 'repo',
    worktreePath: 'repo.rwmcp-session',
    dirty: true
  };
  const service = new WorkSessionLifecycleService(store, fakeWorktrees(worktree), async () => emptyRuntime());

  const result = await service.close(session.id);
  assert.equal(result.state, 'needs-owner-or-explicit-action');
  assert.equal(result.cleanupPerformed, false);
  assert.equal(result.worktree.worktreePath, worktree.worktreePath);
  assert.equal(result.worktree.dirty, true);
  assert.match(result.reason ?? '', /dirty work|modified, staged or untracked/i);
  assert.equal(result.session.status, 'active');
});

test('clean close records CLOSED without deleting the worktree or performing cleanup', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-phase3h-close-clean-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const store = new WorkSessionStore('openai-tunnel', { file: path.join(root, 'sessions.json') });
  const session = await store.create({ workspace: 'demo' });
  await store.touch(session.id);

  const worktree: WorktreeState = {
    sessionId: session.id,
    workspace: 'demo',
    repoPath: 'repo',
    worktreePath: 'repo.rwmcp-session',
    dirty: false
  };
  const service = new WorkSessionLifecycleService(store, fakeWorktrees(worktree), async () => emptyRuntime());

  const result = await service.close(session.id);
  assert.equal(result.state, 'closed');
  assert.equal(result.cleanupPerformed, false);
  assert.equal(result.session.status, 'closed');
  assert.equal(result.worktree.worktreePath, worktree.worktreePath);

  const resumed = await store.resume(session.id);
  assert.equal(resumed.status, 'closed');
  assert.equal(resumed.capsule.project?.workspace, 'demo');
});


test('lifecycle preview is read-only and exposes mechanical close and cleanup blockers', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-phase3h-preview-blocked-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const store = new WorkSessionStore('openai-tunnel', { file: path.join(root, 'sessions.json') });
  const session = await store.create({ workspace: 'demo', projectPath: 'repo' });
  await store.touch(session.id);
  const before = await store.inspect(session.id, true);

  const worktree: WorktreeState = {
    sessionId: session.id,
    workspace: 'demo',
    repoPath: 'repo',
    worktreePath: 'repo.rwmcp-session',
    dirty: true
  };
  const runtime = { ...emptyRuntime(), processes: 1 };
  const service = new WorkSessionLifecycleService(store, fakeWorktrees(worktree), async () => runtime);

  const preview = await service.preview(session.id);
  assert.equal(preview.lifecycleClass, 'active');
  assert.equal(preview.close.eligible, false);
  assert.deepEqual(preview.close.blockers, ['RUNTIME_RESOURCES_ACTIVE', 'WORKTREE_DIRTY']);
  assert.equal(preview.cleanup.eligible, false);
  assert.deepEqual(preview.cleanup.blockers, ['RUNTIME_RESOURCES_ACTIVE', 'WORKTREE_DIRTY']);
  assert.equal(preview.authority, 'read-only-preview');
  assert.equal(preview.executionActive, false);

  const after = await store.inspect(session.id, true);
  assert.equal(after.status, before.status);
  assert.equal(after.updatedAt, before.updatedAt);
  assert.equal(after.lastActivityAt, before.lastActivityAt);
});

test('lifecycle preview classifies idle and recovering sessions as stale without auto-cleanup', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-phase3h-preview-stale-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  let now = new Date('2026-09-20T05:00:00.000Z');
  const store = new WorkSessionStore('openai-tunnel', {
    file: path.join(root, 'sessions.json'),
    now: () => now
  });
  const session = await store.create({
    workspace: 'demo',
    projectPath: 'repo',
    idleAfterMinutes: 5,
    expireAfterMinutes: 60
  });
  await store.touch(session.id);
  now = new Date('2026-09-20T05:10:00.000Z');
  await store.reconcileLifecycle();

  const worktree: WorktreeState = {
    sessionId: session.id,
    workspace: 'demo',
    repoPath: 'repo',
    worktreePath: 'repo.rwmcp-session',
    dirty: false
  };
  const service = new WorkSessionLifecycleService(store, fakeWorktrees(worktree), async () => emptyRuntime());

  const preview = await service.preview(session.id);
  assert.equal(preview.session.status, 'idle');
  assert.equal(preview.lifecycleClass, 'stale');
  assert.equal(preview.close.eligible, true);
  assert.equal(preview.cleanup.eligible, true);
});

test('lifecycle preview marks terminal sessions without attempting to close them again', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-phase3h-preview-terminal-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const store = new WorkSessionStore('openai-tunnel', { file: path.join(root, 'sessions.json') });
  const session = await store.create({ workspace: 'demo', projectPath: 'repo' });
  await store.beginClose(session.id);
  await store.completeClose(session.id);

  const worktree: WorktreeState = {
    sessionId: session.id,
    workspace: 'demo',
    repoPath: 'repo',
    worktreePath: 'repo.rwmcp-session',
    dirty: false
  };
  const service = new WorkSessionLifecycleService(store, fakeWorktrees(worktree), async () => emptyRuntime());

  const preview = await service.preview(session.id);
  assert.equal(preview.lifecycleClass, 'terminal');
  assert.equal(preview.close.eligible, false);
  assert.deepEqual(preview.close.blockers, ['SESSION_TERMINAL']);
  assert.equal(preview.cleanup.eligible, true);
});
