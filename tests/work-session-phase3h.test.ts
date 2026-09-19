import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WorkSessionStore } from '../src/work-session.js';

test('work_session_resume is read-only while touch activates execution state', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-phase3h-resume-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'sessions.json');
  let now = new Date('2026-09-19T10:00:00.000Z');
  const store = new WorkSessionStore('openai-tunnel', { file, now: () => now });

  const created = await store.create({ name: 'phase3h', objective: 'handoff' });
  assert.equal(created.status, 'created');
  const persistedBefore = await fs.readFile(file, 'utf8');

  now = new Date('2026-09-19T10:05:00.000Z');
  const resumed = await store.resume(created.id);
  assert.equal(resumed.status, 'created');
  assert.equal(resumed.lastActivityAt, created.lastActivityAt);
  assert.equal(resumed.updatedAt, created.updatedAt);
  assert.equal(await fs.readFile(file, 'utf8'), persistedBefore);

  const activated = await store.touch(created.id);
  assert.equal(activated.status, 'active');
  assert.equal(activated.lastActivityAt, now.toISOString());
  assert.equal(activated.updatedAt, now.toISOString());
});

test('restart reconciliation, idle threshold and expiry preserve explicit lifecycle states', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-phase3h-lifecycle-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  let now = new Date('2026-09-19T11:00:00.000Z');
  const store = new WorkSessionStore('openai-tunnel', {
    file: path.join(root, 'sessions.json'),
    now: () => now
  });

  const session = await store.create({
    idleAfterMinutes: 10,
    expireAfterMinutes: 20
  });
  assert.equal((await store.touch(session.id)).status, 'active');

  now = new Date('2026-09-19T11:05:00.000Z');
  const recovered = await store.reconcileLifecycle();
  assert.deepEqual(recovered, { recovered: 1, idled: 0, expired: 0 });
  assert.equal((await store.resume(session.id)).status, 'recovering');

  assert.equal((await store.touch(session.id)).status, 'active');
  now = new Date('2026-09-19T11:16:00.000Z');
  const idled = await store.reconcileLifecycle();
  assert.equal(idled.recovered, 1);
  assert.equal(idled.idled, 1);
  assert.equal((await store.resume(session.id)).status, 'idle');

  now = new Date('2026-09-19T11:26:00.000Z');
  const expired = await store.reconcileLifecycle();
  assert.equal(expired.expired, 1);
  const terminal = await store.resume(session.id);
  assert.equal(terminal.status, 'expired');
  assert.equal(terminal.lifecycleReason, 'IDLE_EXPIRY');
});

test('bounded GC removes at most its configured batch and retains terminal sessions with worktrees', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-phase3h-gc-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  let now = new Date('2026-09-19T12:00:00.000Z');
  const store = new WorkSessionStore('openai-tunnel', {
    file: path.join(root, 'sessions.json'),
    now: () => now,
    terminalRetentionMs: 0,
    gcMaxRecords: 1
  });

  const retained = await store.create({ workspace: 'demo' });
  await store.updateProject(retained.id, {
    workspace: 'demo',
    repoPath: 'repo',
    worktreePath: 'repo.rwmcp-retained'
  });
  await store.beginClose(retained.id);
  await store.completeClose(retained.id);

  const first = await store.create();
  await store.beginClose(first.id);
  await store.completeClose(first.id);
  const second = await store.create();
  await store.beginClose(second.id);
  await store.completeClose(second.id);

  now = new Date('2026-09-19T12:01:00.000Z');
  const gc = await store.garbageCollect();
  assert.deepEqual(gc, { removed: 1, retainedWithWorktree: 1 });

  const remaining = await store.list(true);
  assert.equal(remaining.length, 2);
  assert.ok(remaining.some(item => item.id === retained.id));
  assert.equal(remaining.filter(item => item.status === 'closed').length, 2);
});
