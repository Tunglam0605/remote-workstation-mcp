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
