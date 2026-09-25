import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runWithWorkSession } from '../src/security/execution-context.js';
import { TaskAttemptStore } from '../src/task-attempt-store.js';

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
