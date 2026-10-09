import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runWithWorkSession } from '../src/security/execution-context.js';
import {
  TaskAttemptStore,
  atomicRenameWithRetry,
  isRetryableWindowsFsError,
  DEFAULT_WINDOWS_RENAME_RETRY_DELAYS_MS,
  RETRYABLE_WINDOWS_FS_ERROR_CODES
} from '../src/task-attempt-store.js';

const SESSION_A = '66666666-6666-4666-8666-666666666666';
const SESSION_B = '77777777-7777-4777-8777-777777777777';
const OBJECTIVE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TASK = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-task-attempt-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  let tick = 0;
  const store = new TaskAttemptStore('openai-tunnel', {
    file: path.join(root, 'task-attempts.json'),
    now: () => new Date(1_840_000_000_000 + tick++ * 1000)
  });
  return { root, store };
}

test('Task Attempt store requires explicit Work Session and isolates sibling sessions', async t => {
  const { store } = await fixture(t);
  await assert.rejects(
    store.begin(OBJECTIVE, TASK, 1),
    /explicit Work Session/
  );

  const created = await runWithWorkSession(SESSION_A, () =>
    store.begin(OBJECTIVE, TASK, 1)
  );
  assert.equal(created.created, true);

  const replay = await runWithWorkSession(SESSION_A, () =>
    store.begin(OBJECTIVE, TASK, 1)
  );
  assert.equal(replay.created, false);
  assert.equal(replay.attempt.id, created.attempt.id);

  await runWithWorkSession(SESSION_B, async () => {
    assert.deepEqual(await store.list(), []);
    assert.equal(await store.getForGeneration(OBJECTIVE, TASK, 1), undefined);
  });
});

test('Task Attempt restart reconciliation marks running work interrupted instead of resurrecting it', async t => {
  const { store } = await fixture(t);
  const attempt = await runWithWorkSession(SESSION_A, async () =>
    (await store.begin(OBJECTIVE, TASK, 1)).attempt
  );
  assert.equal(attempt.status, 'running');

  const reconciled = await store.reconcileInterrupted();
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0]?.status, 'interrupted');

  const persisted = await runWithWorkSession(SESSION_A, () =>
    store.getForGeneration(OBJECTIVE, TASK, 1)
  );
  assert.equal(persisted?.status, 'interrupted');

  const replay = await runWithWorkSession(SESSION_A, () =>
    store.begin(OBJECTIVE, TASK, 1)
  );
  assert.equal(replay.created, false);
  assert.equal(replay.attempt.status, 'interrupted');
});

test('Task Attempt cancellation intent is durable but final real outcome remains authoritative', async t => {
  const { store } = await fixture(t);
  const attempt = await runWithWorkSession(SESSION_A, async () =>
    (await store.begin(OBJECTIVE, TASK, 1)).attempt
  );

  const requested = await runWithWorkSession(SESSION_A, () =>
    store.requestCancellation(OBJECTIVE, TASK, 1)
  );
  assert.equal(requested?.status, 'running');
  assert.ok(requested?.cancelRequestedAt);

  const finished = await runWithWorkSession(SESSION_A, () =>
    store.finish(attempt.id, 'succeeded', {
      workflowRunId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    })
  );
  assert.equal(finished.status, 'succeeded');
  assert.ok(finished.cancelRequestedAt);
  assert.equal(finished.workflowRunId, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc');
});


test('Task Attempt store updates live provider stage and accepts a cancelled provider trace', async t => {
  const { store } = await fixture(t);
  await runWithWorkSession(SESSION_A, async () => {
    const attempt = (await store.begin(OBJECTIVE, TASK, 1, { providerId: 'codex-local' })).attempt;
    const running = await store.updateRunning(attempt.id, {
      providerId: 'antigravity-local',
      providerAttempts: [{ providerId: 'codex-local', status: 'failed', summary: 'clean fallback' }]
    });
    assert.equal(running.status, 'running');
    assert.equal(running.providerId, 'antigravity-local');
    assert.deepEqual(running.providerAttempts?.map(item => [item.providerId, item.status]), [['codex-local', 'failed']]);
    const finished = await store.finish(attempt.id, 'cancelled', {
      providerId: 'antigravity-local',
      providerAttempts: [
        { providerId: 'codex-local', status: 'failed', summary: 'clean fallback' },
        { providerId: 'antigravity-local', status: 'cancelled', summary: 'cancelled-by-request' }
      ]
    });
    assert.equal(finished.status, 'cancelled');
    assert.deepEqual(finished.providerAttempts?.map(item => item.status), ['failed', 'cancelled']);
  });
});

test('Task Attempt store retries transient Windows rename failures (EPERM/EBUSY/EACCES) and persists state atomically', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-task-attempt-transient-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'task-attempts.json');
  let renameCalls = 0;
  const sleeps: number[] = [];

  const store = new TaskAttemptStore('openai-tunnel', {
    file,
    platform: 'win32',
    renameRetryDelaysMs: [2, 4, 8],
    renameSleep: async ms => { sleeps.push(ms); },
    renameFn: async (src, dst) => {
      renameCalls += 1;
      if (renameCalls === 1) {
        throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
      }
      if (renameCalls === 2) {
        throw Object.assign(new Error('EBUSY: resource busy or locked, rename'), { code: 'EBUSY' });
      }
      await fs.rename(src, dst);
    }
  });

  const created = await runWithWorkSession(SESSION_A, () =>
    store.begin(OBJECTIVE, TASK, 1)
  );
  assert.equal(created.created, true);
  assert.equal(created.attempt.status, 'running');
  assert.equal(renameCalls, 3);
  assert.deepEqual(sleeps, [2, 4]);

  // Verify no orphaned temporary files remain
  const files = await fs.readdir(root);
  assert.deepEqual(files, ['task-attempts.json']);

  // Verify persistence and restart
  const restarted = new TaskAttemptStore('openai-tunnel', { file });
  const persisted = await runWithWorkSession(SESSION_A, () =>
    restarted.getForGeneration(OBJECTIVE, TASK, 1)
  );
  assert.equal(persisted?.id, created.attempt.id);
  assert.equal(persisted?.status, 'running');
});

test('Task Attempt store surfaces persistent Windows rename failure after exhausting bounded retries, cleans up temp, and never deletes destination', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-task-attempt-permanent-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'task-attempts.json');

  // Step 1: Seed a valid destination file
  const initialStore = new TaskAttemptStore('openai-tunnel', { file });
  const initial = await runWithWorkSession(SESSION_A, () =>
    initialStore.begin(OBJECTIVE, TASK, 1)
  );
  assert.equal(initial.created, true);

  // Verify initial file exists and contains valid JSON
  const initialContent = await fs.readFile(file, 'utf8');
  assert.ok(initialContent.includes(initial.attempt.id));

  // Step 2: Attempt save with failing rename on Windows
  let renameCalls = 0;
  const sleeps: number[] = [];
  const failingStore = new TaskAttemptStore('openai-tunnel', {
    file,
    platform: 'win32',
    renameRetryDelaysMs: [1, 2, 3],
    renameSleep: async ms => { sleeps.push(ms); },
    renameFn: async () => {
      renameCalls += 1;
      throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
    }
  });

  await assert.rejects(
    runWithWorkSession(SESSION_A, () => failingStore.begin(OBJECTIVE, TASK, 2)),
    (err: any) => err?.code === 'EPERM'
  );

  // 1 initial attempt + 3 retries = 4 total attempts
  assert.equal(renameCalls, 4);
  assert.deepEqual(sleeps, [1, 2, 3]);

  // Destination file MUST still exist with original content (never silently deleted)
  const contentAfterFailure = await fs.readFile(file, 'utf8');
  assert.equal(contentAfterFailure, initialContent);

  // Temporary files must have been cleaned up
  const files = await fs.readdir(root);
  assert.deepEqual(files, ['task-attempts.json']);
});

test('Task Attempt store does not retry non-retryable filesystem errors on Windows', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-task-attempt-nonretryable-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'task-attempts.json');
  let renameCalls = 0;

  const store = new TaskAttemptStore('openai-tunnel', {
    file,
    platform: 'win32',
    renameRetryDelaysMs: [5, 10, 20],
    renameFn: async () => {
      renameCalls += 1;
      throw Object.assign(new Error('ENOSPC: no space left on device, rename'), { code: 'ENOSPC' });
    }
  });

  await assert.rejects(
    runWithWorkSession(SESSION_A, () => store.begin(OBJECTIVE, TASK, 1)),
    (err: any) => err?.code === 'ENOSPC'
  );
  assert.equal(renameCalls, 1);

  // Temporary files must be cleaned up
  const files = await fs.readdir(root);
  assert.deepEqual(files, []);
});

test('Task Attempt store preserves unaffected Linux behavior and does not retry on Linux', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-task-attempt-linux-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'task-attempts.json');
  let renameCalls = 0;

  const store = new TaskAttemptStore('openai-tunnel', {
    file,
    platform: 'linux',
    renameRetryDelaysMs: [5, 10, 20],
    renameFn: async () => {
      renameCalls += 1;
      throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
    }
  });

  await assert.rejects(
    runWithWorkSession(SESSION_A, () => store.begin(OBJECTIVE, TASK, 1)),
    (err: any) => err?.code === 'EPERM'
  );
  assert.equal(renameCalls, 1);

  // Temporary files must be cleaned up
  const files = await fs.readdir(root);
  assert.deepEqual(files, []);
});

test('isRetryableWindowsFsError and atomicRenameWithRetry helpers validate codes and retry bounds', async t => {
  assert.deepEqual([...RETRYABLE_WINDOWS_FS_ERROR_CODES], ['EPERM', 'EBUSY', 'EACCES']);
  assert.deepEqual([...DEFAULT_WINDOWS_RENAME_RETRY_DELAYS_MS], [5, 10, 20, 40, 80]);

  assert.equal(isRetryableWindowsFsError({ code: 'EPERM' }), true);
  assert.equal(isRetryableWindowsFsError({ code: 'EBUSY' }), true);
  assert.equal(isRetryableWindowsFsError({ code: 'EACCES' }), true);
  assert.equal(isRetryableWindowsFsError({ code: 'ENOENT' }), false);
  assert.equal(isRetryableWindowsFsError({ code: 'ENOSPC' }), false);
  assert.equal(isRetryableWindowsFsError(new Error('generic error')), false);
  assert.equal(isRetryableWindowsFsError(null), false);
  assert.equal(isRetryableWindowsFsError(undefined), false);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-atomic-rename-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const src = path.join(root, 'source.tmp');
  const dst = path.join(root, 'destination.json');
  await fs.writeFile(src, 'content', 'utf8');

  let attempts = 0;
  const sleeps: number[] = [];
  await atomicRenameWithRetry(src, dst, {
    platform: 'win32',
    retryDelaysMs: [1, 2],
    sleep: async ms => { sleeps.push(ms); },
    renameFn: async (s, d) => {
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      }
      await fs.rename(s, d);
    }
  });
  assert.equal(attempts, 2);
  assert.deepEqual(sleeps, [1]);
  assert.equal(await fs.readFile(dst, 'utf8'), 'content');
});

