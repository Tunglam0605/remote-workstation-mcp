import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runWithWorkSession } from '../src/security/execution-context.js';
import { WorkflowRunStore } from '../src/workflow-run-store.js';

test('workflow run store attributes runs to principal plus Work Session and hides sibling sessions', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-workflow-runs-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'workflow-runs.json');
  const store = new WorkflowRunStore('openai-tunnel', { file });
  const sessionA = '11111111-1111-4111-8111-111111111111';
  const sessionB = '22222222-2222-4222-8222-222222222222';

  const runA = await runWithWorkSession(sessionA, () =>
    store.begin('stm32', 'B300-Main-Custom', 'firmware.build')
  );
  assert.equal(runA.workSessionId, sessionA);
  assert.equal(runA.status, 'running');

  const finishedA = await runWithWorkSession(sessionA, () =>
    store.finish(runA.id, 'succeeded')
  );
  assert.equal(finishedA.status, 'succeeded');
  assert.ok(finishedA.endedAt);

  await runWithWorkSession(sessionB, async () => {
    assert.deepEqual(await store.list(), []);
    await assert.rejects(store.get(runA.id), /Unknown workflow run/);
    await assert.rejects(store.finish(runA.id, 'failed'), /Unknown workflow run/);
  });

  const listedA = await runWithWorkSession(sessionA, () => store.list());
  assert.equal(listedA.length, 1);
  assert.equal(listedA[0]?.id, runA.id);
});

test('restart reconciliation marks durable running workflow records failed without resurrecting ownership', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-workflow-reconcile-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'workflow-runs.json');
  const sessionA = '11111111-1111-4111-8111-111111111111';

  const first = new WorkflowRunStore('openai-tunnel', { file });
  const run = await runWithWorkSession(sessionA, () =>
    first.begin('projects', 'repo', 'firmware.build')
  );
  assert.equal(run.status, 'running');

  const afterRestart = new WorkflowRunStore('openai-tunnel', { file });
  assert.equal(await afterRestart.reconcileInterrupted(), 1);
  assert.equal(await afterRestart.reconcileInterrupted(), 0);

  const recovered = await runWithWorkSession(sessionA, () => afterRestart.get(run.id));
  assert.equal(recovered.status, 'failed');
  assert.equal(recovered.error, 'runtime-restarted-before-completion');
  assert.ok(recovered.endedAt);
});

test('workflow run store bounds retained records and error text', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-workflow-bounded-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'workflow-runs.json');
  const store = new WorkflowRunStore('openai-tunnel', { file, maxRecords: 100 });
  const session = '11111111-1111-4111-8111-111111111111';

  for (let i = 0; i < 105; i += 1) {
    const run = await runWithWorkSession(session, () =>
      store.begin('w', '.', `workflow-${i}`)
    );
    await runWithWorkSession(session, () =>
      store.finish(run.id, 'failed', 'x'.repeat(2048))
    );
  }

  const listed = await runWithWorkSession(session, () => store.list(200));
  assert.equal(listed.length, 100);
  assert.equal(listed[0]?.workflow, 'workflow-104');
  assert.equal(listed[0]?.error?.length, 1024);
});
