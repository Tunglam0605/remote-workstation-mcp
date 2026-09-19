import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runWithWorkSession } from '../src/security/execution-context.js';
import { DeterministicTaskScheduler, TaskGraphStore } from '../src/task-graph.js';

const SESSION_A = '11111111-1111-4111-8111-111111111111';
const SESSION_B = '22222222-2222-4222-8222-222222222222';
const EXECUTION = {
  kind: 'engineering-workflow' as const,
  workspace: 'projects',
  projectPath: 'demo',
  workflow: 'firmware.build',
  parameters: {}
};

async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-task-graph-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  let tick = 0;
  const store = new TaskGraphStore('openai-tunnel', {
    file: path.join(root, 'work-objectives.json'),
    now: () => new Date(1_800_000_000_000 + tick++ * 1000)
  });
  return { root, store };
}

test('Task Graph requires an explicit Work Session and isolates objectives by session', async t => {
  const { root, store } = await fixture(t);

  await assert.rejects(
    store.create({ name: 'implicit', objective: 'must fail closed' }),
    /explicit Work Session/
  );

  const objective = await runWithWorkSession(SESSION_A, () =>
    store.create({ name: 'Phase 3', objective: 'Build deterministic scheduling' })
  );
  assert.equal(objective.workSessionId, SESSION_A);

  await runWithWorkSession(SESSION_B, async () => {
    assert.deepEqual(await store.list(), []);
    await assert.rejects(store.get(objective.id), /Unknown Work Objective/);
  });

  const reloaded = new TaskGraphStore('openai-tunnel', {
    file: path.join(root, 'work-objectives.json')
  });
  const resumed = await runWithWorkSession(SESSION_A, () => reloaded.get(objective.id));
  assert.equal(resumed.id, objective.id);
});

test('Task Graph validates dependencies, rejects cycles and derives READY deterministically', async t => {
  const { store } = await fixture(t);
  const objective = await runWithWorkSession(SESSION_A, () =>
    store.create({ name: 'DAG', objective: 'Validate dependency graph' })
  );

  const a = await runWithWorkSession(SESSION_A, () =>
    store.addTask(objective.id, { title: 'A', priority: 1 })
  );
  const b = await runWithWorkSession(SESSION_A, () =>
    store.addTask(objective.id, { title: 'B', priority: 10 })
  );
  const c = await runWithWorkSession(SESSION_A, () =>
    store.addTask(objective.id, { title: 'C', dependencies: [a.id, b.id] })
  );

  assert.equal(a.status, 'ready');
  assert.equal(b.status, 'ready');
  assert.equal(c.status, 'pending');

  const ready = await runWithWorkSession(SESSION_A, () => store.readyTasks(objective.id));
  assert.deepEqual(ready.map(task => task.id), [b.id, a.id]);

  await runWithWorkSession(SESSION_A, () => store.replaceDependencies(objective.id, a.id, [b.id]));
  await assert.rejects(
    runWithWorkSession(SESSION_A, () => store.replaceDependencies(objective.id, b.id, [a.id])),
    /cycle detected/
  );

  await assert.rejects(
    runWithWorkSession(SESSION_A, () => store.addTask(objective.id, {
      title: 'unknown dependency',
      dependencies: ['ffffffff-ffff-4fff-8fff-ffffffffffff']
    })),
    /unknown task/
  );
});

test('task completion unlocks dependents while failure propagates BLOCKED transitively', async t => {
  const { store } = await fixture(t);
  const objective = await runWithWorkSession(SESSION_A, () =>
    store.create({ name: 'Propagation', objective: 'Exercise success and failure propagation' })
  );

  const a = await runWithWorkSession(SESSION_A, () => store.addTask(objective.id, { title: 'A' }));
  const b = await runWithWorkSession(SESSION_A, () => store.addTask(objective.id, { title: 'B', dependencies: [a.id] }));
  const c = await runWithWorkSession(SESSION_A, () => store.addTask(objective.id, { title: 'C', dependencies: [b.id] }));

  await runWithWorkSession(SESSION_A, () => store.startTask(objective.id, a.id));
  await runWithWorkSession(SESSION_A, () => store.finishTask(objective.id, a.id, 'succeeded'));

  let state = await runWithWorkSession(SESSION_A, () => store.get(objective.id));
  assert.equal(state.tasks.find(task => task.id === b.id)?.status, 'ready');
  assert.equal(state.tasks.find(task => task.id === c.id)?.status, 'pending');

  await runWithWorkSession(SESSION_A, () => store.startTask(objective.id, b.id));
  await runWithWorkSession(SESSION_A, () => store.finishTask(objective.id, b.id, 'failed', 'build failed'));

  state = await runWithWorkSession(SESSION_A, () => store.get(objective.id));
  assert.equal(state.status, 'failed');
  assert.equal(state.tasks.find(task => task.id === b.id)?.error, 'build failed');
  assert.equal(state.tasks.find(task => task.id === c.id)?.status, 'blocked');
  assert.equal(state.tasks.find(task => task.id === c.id)?.error, 'blocked-by-dependency');
});

test('restart reconciliation fails stale RUNNING tasks and blocks their descendants', async t => {
  const { store } = await fixture(t);
  const objective = await runWithWorkSession(SESSION_A, () =>
    store.create({ name: 'Restart', objective: 'Do not resurrect stale work' })
  );

  const a = await runWithWorkSession(SESSION_A, () => store.addTask(objective.id, { title: 'A' }));
  const b = await runWithWorkSession(SESSION_A, () => store.addTask(objective.id, { title: 'B', dependencies: [a.id] }));
  await runWithWorkSession(SESSION_A, () => store.startTask(objective.id, a.id));

  const reconciled = await runWithWorkSession(SESSION_A, () =>
    store.reconcileInterrupted('runtime-restarted-before-task-completion')
  );
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0]?.id, a.id);
  assert.equal(reconciled[0]?.status, 'failed');

  const state = await runWithWorkSession(SESSION_A, () => store.get(objective.id));
  assert.equal(state.tasks.find(task => task.id === b.id)?.status, 'blocked');
  assert.equal(state.status, 'failed');
});

test('deterministic scheduler classifies concurrency without granting or acquiring authority', async t => {
  const { store } = await fixture(t);
  const objective = await runWithWorkSession(SESSION_A, () =>
    store.create({ name: 'Scheduler', objective: 'Plan safe ready work' })
  );

  const shared = await runWithWorkSession(SESSION_A, () => store.addTask(objective.id, {
    title: 'inspect',
    priority: 20,
    concurrency: { operation: 'project.inspect' },
    execution: EXECUTION
  }));
  const missingKey = await runWithWorkSession(SESSION_A, () => store.addTask(objective.id, {
    title: 'probe missing key',
    priority: 10,
    concurrency: { operation: 'hardware.debug-probe' },
    execution: EXECUTION
  }));
  const keyed = await runWithWorkSession(SESSION_A, () => store.addTask(objective.id, {
    title: 'probe keyed',
    priority: 5,
    concurrency: { operation: 'hardware.debug-probe', key: 'stlink:serial:123' },
    execution: EXECUTION
  }));
  const ownerOnly = await runWithWorkSession(SESSION_A, () => store.addTask(objective.id, {
    title: 'policy',
    concurrency: { operation: 'owner.policy' },
    execution: EXECUTION
  }));

  const scheduler = new DeterministicTaskScheduler(store);
  const plan = await runWithWorkSession(SESSION_A, () => scheduler.plan(objective.id));

  assert.deepEqual(plan.map(item => item.task.id), [shared.id, missingKey.id, keyed.id, ownerOnly.id]);
  assert.equal(plan[0]?.dispatchable, true);
  assert.equal(plan[0]?.requiresLeaseCheck, false);
  assert.equal(plan[1]?.dispatchable, false);
  assert.equal(plan[1]?.blocker, 'CONCURRENCY_KEY_REQUIRED');
  assert.equal(plan[2]?.dispatchable, true);
  assert.equal(plan[2]?.requiresLeaseCheck, true);
  assert.equal(plan[3]?.dispatchable, false);
  assert.equal(plan[3]?.blocker, 'OWNER_LOCAL_ONLY');
});


test('scheduler refuses READY work without a persisted typed execution binding', async t => {
  const { store } = await fixture(t);
  const objective = await runWithWorkSession(SESSION_A, () =>
    store.create({ name: 'Binding', objective: 'Require typed execution binding' })
  );
  const task = await runWithWorkSession(SESSION_A, () => store.addTask(objective.id, {
    title: 'unbound',
    concurrency: { operation: 'project.inspect' }
  }));
  const scheduler = new DeterministicTaskScheduler(store);
  const plan = await runWithWorkSession(SESSION_A, () => scheduler.plan(objective.id));
  assert.equal(plan[0]?.task.id, task.id);
  assert.equal(plan[0]?.dispatchable, false);
  assert.equal(plan[0]?.blocker, 'EXECUTION_BINDING_REQUIRED');
});

test('Task Graph rejects transient workflow secrets and payload bytes before persistence', async t => {
  const { root, store } = await fixture(t);
  const objective = await runWithWorkSession(SESSION_A, () =>
    store.create({ name: 'Secrets', objective: 'Do not persist transient credentials' })
  );

  await assert.rejects(
    runWithWorkSession(SESSION_A, () => store.addTask(objective.id, {
      title: 'secret binding',
      concurrency: { operation: 'project.inspect' },
      execution: {
        kind: 'engineering-workflow',
        workspace: 'projects',
        projectPath: 'demo',
        workflow: 'firmware.build',
        parameters: {
          transferTicket: 'abcdefghijklmnopqrstuvwxyzABCDEFGH12345678'
        }
      } as never
    }))
  );

  const raw = await fs.readFile(path.join(root, 'work-objectives.json'), 'utf8');
  assert.doesNotMatch(raw, /transferTicket/);
  assert.doesNotMatch(raw, /abcdefghijklmnopqrstuvwxyzABCDEFGH12345678/);
});


test('cancellation blocks dependents and explicit retry advances generation without mutating history', async t => {
  const { store } = await fixture(t);
  await runWithWorkSession(SESSION_A, async () => {
    const objective = await store.create({
      name: 'Generation',
      objective: 'Cancel then retry explicitly'
    });
    const parent = await store.addTask(objective.id, {
      title: 'parent',
      concurrency: { operation: 'project.inspect' },
      execution: EXECUTION
    });
    const child = await store.addTask(objective.id, {
      title: 'child',
      dependencies: [parent.id],
      concurrency: { operation: 'project.inspect' },
      execution: EXECUTION
    });

    const cancelled = await store.cancelTask(objective.id, parent.id);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.generation, 1);

    let state = await store.get(objective.id);
    assert.equal(state.tasks.find(item => item.id === child.id)?.status, 'blocked');
    assert.equal(state.status, 'blocked');

    const retried = await store.retryTask(objective.id, parent.id);
    assert.equal(retried.generation, 2);
    assert.equal(retried.status, 'ready');
    assert.equal(retried.startedAt, undefined);
    assert.equal(retried.endedAt, undefined);
    assert.equal(retried.error, undefined);

    state = await store.get(objective.id);
    assert.equal(state.tasks.find(item => item.id === child.id)?.status, 'pending');
    assert.equal(state.status, 'active');

    await assert.rejects(
      store.retryTask(objective.id, parent.id),
      /TASK_NOT_RETRYABLE/
    );
  });
});
