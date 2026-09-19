import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { NodeInterlockStore } from '../src/node-interlock.js';
import { runWithWorkSession } from '../src/security/execution-context.js';

test('node interlocks are durable, Work Session scoped, and stale owner PIDs reconcile away', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-node-interlock-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'runtime', 'work-session-interlocks.json');
  const livePids = new Set([1234]);
  const sessionA = '11111111-1111-4111-8111-111111111111';
  const sessionB = '22222222-2222-4222-8222-222222222222';

  const first = new NodeInterlockStore('openai-tunnel', {
    file,
    pid: 1234,
    pidAlive: pid => livePids.has(pid)
  });
  const record = await runWithWorkSession(sessionA, () =>
    first.acquireWorkflow('firmware.build:stm32:B300')
  );
  assert.equal(record.pid, 1234);
  assert.equal(record.workSessionId, sessionA);
  assert.equal((await first.listActive()).length, 1);

  await runWithWorkSession(sessionB, async () => {
    assert.deepEqual(await first.listOwned(), []);
    await assert.rejects(first.release(record.id), /Unknown node interlock/);
  });

  const afterReconnect = new NodeInterlockStore('openai-tunnel', {
    file,
    pid: 5678,
    pidAlive: pid => livePids.has(pid)
  });
  assert.equal((await afterReconnect.listActive()).length, 1);

  livePids.clear();
  assert.equal(await afterReconnect.reconcileStale(), 1);
  assert.deepEqual(await afterReconnect.listActive(), []);
});

test('node interlock release is restricted to the acquiring runtime and Work Session', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-node-interlock-owner-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'interlocks.json');
  const session = '11111111-1111-4111-8111-111111111111';
  const livePids = new Set([100, 200]);

  const owner = new NodeInterlockStore('openai-tunnel', {
    file,
    pid: 100,
    pidAlive: pid => livePids.has(pid)
  });
  const record = await runWithWorkSession(session, () => owner.acquireWorkflow('ros2.build:w:project'));

  const otherRuntime = new NodeInterlockStore('openai-tunnel', {
    file,
    pid: 200,
    pidAlive: pid => livePids.has(pid)
  });
  await assert.rejects(
    runWithWorkSession(session, () => otherRuntime.release(record.id)),
    /Unknown node interlock/
  );
  await runWithWorkSession(session, () => owner.release(record.id));
  assert.deepEqual(await owner.listActive(), []);
});
