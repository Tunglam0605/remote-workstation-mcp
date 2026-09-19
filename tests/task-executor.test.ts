import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EngineeringResourceManager } from '../src/adapters/engineering/resource-manager.js';
import { NodeInterlockStore } from '../src/node-interlock.js';
import { runWithWorkSession } from '../src/security/execution-context.js';
import { TaskExecutionCoordinator } from '../src/task-executor.js';
import { DeterministicTaskScheduler, TaskGraphStore } from '../src/task-graph.js';

const SESSION = '33333333-3333-4333-8333-333333333333';

async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-task-executor-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  let tick = 0;
  const store = new TaskGraphStore('openai-tunnel', {
    file: path.join(root, 'objectives.json'),
    now: () => new Date(1_810_000_000_000 + tick++ * 1000)
  });
  const scheduler = new DeterministicTaskScheduler(store);
  const resources = new EngineeringResourceManager('openai-tunnel');
  const interlocks = new NodeInterlockStore('openai-tunnel', {
    file: path.join(root, 'interlocks.json'),
    pid: 4242,
    pidAlive: () => true
  });
  const executor = new TaskExecutionCoordinator(store, scheduler, resources, interlocks);
  return { store, scheduler, resources, interlocks, executor };
}

test('executor marks success only after callback completion and unlocks dependent work', async t => {
  const { store, executor } = await fixture(t);
  await runWithWorkSession(SESSION, async () => {
    const objective = await store.create({ name: 'execute', objective: 'Run verified callbacks' });
    const first = await store.addTask(objective.id, {
      title: 'first',
      concurrency: { operation: 'project.inspect' }
    });
    const second = await store.addTask(objective.id, {
      title: 'second',
      dependencies: [first.id],
      concurrency: { operation: 'project.inspect' }
    });

    const result = await executor.execute(objective.id, first.id, async () => 42);
    assert.equal(result.result, 42);
    assert.equal(result.task.status, 'succeeded');

    let state = await store.get(objective.id);
    assert.equal(state.tasks.find(task => task.id === second.id)?.status, 'ready');

    await assert.rejects(
      executor.execute(objective.id, second.id, async () => {
        throw new Error('verification failed');
      }),
      /verification failed/
    );

    state = await store.get(objective.id);
    assert.equal(state.tasks.find(task => task.id === second.id)?.status, 'failed');
    assert.equal(state.tasks.find(task => task.id === second.id)?.error, 'verification failed');
    assert.equal(state.status, 'failed');
  });
});

test('executor refuses unclassified READY work without changing its state', async t => {
  const { store, executor } = await fixture(t);
  await runWithWorkSession(SESSION, async () => {
    const objective = await store.create({ name: 'unclassified', objective: 'Fail closed' });
    const task = await store.addTask(objective.id, { title: 'needs classification' });

    await assert.rejects(
      executor.execute(objective.id, task.id, async () => 'should-not-run'),
      /CONCURRENCY_OPERATION_REQUIRED/
    );

    const state = await store.get(objective.id);
    assert.equal(state.tasks.find(item => item.id === task.id)?.status, 'ready');
  });
});

test('executor keeps same exclusive resource key single-owner and leaves rejected task READY', async t => {
  const { store, resources, executor } = await fixture(t);
  await runWithWorkSession(SESSION, async () => {
    const objective = await store.create({ name: 'stlink', objective: 'Serialize one debug probe' });
    const first = await store.addTask(objective.id, {
      title: 'flash A',
      concurrency: { operation: 'hardware.debug-probe', key: 'stlink:serial:ABC' }
    });
    const second = await store.addTask(objective.id, {
      title: 'flash B',
      concurrency: { operation: 'hardware.debug-probe', key: 'stlink:serial:ABC' }
    });

    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });

    const running = executor.execute(objective.id, first.id, async () => {
      started();
      await gate;
      return 'done';
    });
    await entered;

    assert.equal(resources.activeCount(), 1);
    await assert.rejects(
      executor.execute(objective.id, second.id, async () => 'must-not-run'),
      /RESOURCE_BUSY/
    );
    let state = await store.get(objective.id);
    assert.equal(state.tasks.find(item => item.id === second.id)?.status, 'ready');

    release();
    await running;
    assert.equal(resources.activeCount(), 0);

    state = await store.get(objective.id);
    assert.equal(state.tasks.find(item => item.id === first.id)?.status, 'succeeded');
    assert.equal(state.tasks.find(item => item.id === second.id)?.status, 'ready');
  });
});

test('node-exclusive execution owns a lifecycle interlock only for the callback lifetime', async t => {
  const { store, interlocks, executor } = await fixture(t);
  await runWithWorkSession(SESSION, async () => {
    const objective = await store.create({ name: 'node', objective: 'Protect node lifecycle' });
    const task = await store.addTask(objective.id, {
      title: 'node-wide maintenance',
      concurrency: { operation: 'node.restart', key: 'node' }
    });

    await executor.execute(objective.id, task.id, async () => {
      const active = await interlocks.listActive();
      assert.equal(active.length, 1);
      assert.equal(active[0]?.workSessionId, SESSION);
      return undefined;
    });

    assert.deepEqual(await interlocks.listActive(), []);
    assert.equal((await store.get(objective.id)).tasks[0]?.status, 'succeeded');
  });
});
