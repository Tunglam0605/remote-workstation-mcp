import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EngineeringResourceManager } from '../src/adapters/engineering/resource-manager.js';
import { NodeInterlockStore } from '../src/node-interlock.js';
import { runWithWorkSession } from '../src/security/execution-context.js';
import { SchedulerAwarenessService } from '../src/scheduler-awareness.js';
import { TaskAttemptStore } from '../src/task-attempt-store.js';
import { TaskExecutionCoordinator } from '../src/task-executor.js';
import { DeterministicTaskScheduler, TaskGraphStore } from '../src/task-graph.js';
import { WorkSessionStore } from '../src/work-session.js';

const EXECUTION = {
  kind: 'engineering-workflow' as const,
  workspace: 'projects',
  projectPath: 'demo',
  workflow: 'firmware.build',
  parameters: {}
};

async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-scheduler-awareness-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  let tick = 0;
  const now = () => new Date(1_850_000_000_000 + tick++ * 1000);
  const workSessions = new WorkSessionStore('openai-tunnel', {
    file: path.join(root, 'sessions.json'),
    now
  });
  const sessionA = await workSessions.create({ name: 'A', workspace: 'projects', projectPath: 'repo' });
  const sessionB = await workSessions.create({ name: 'B', workspace: 'projects', projectPath: 'repo' });
  const taskGraphs = new TaskGraphStore('openai-tunnel', {
    file: path.join(root, 'objectives.json'),
    now
  });
  const attempts = new TaskAttemptStore('openai-tunnel', {
    file: path.join(root, 'attempts.json'),
    now
  });
  const resources = new EngineeringResourceManager('openai-tunnel');
  const interlocks = new NodeInterlockStore('openai-tunnel', {
    file: path.join(root, 'interlocks.json'),
    now,
    pid: 8585,
    pidAlive: () => true
  });
  const scheduler = new DeterministicTaskScheduler(taskGraphs);
  const serial = { list: () => [{ id: 'serial-own', resourceId: 'serial:COM9', port: 'COM9', baudRate: 115200, status: 'open' as const, startedAt: now().toISOString(), bytesRead: 0, bufferedBytes: 0 }] };
  const debug = { list: () => [{ id: 'debug-own', workspace: 'projects', resourceId: 'debug-probe:OWN', probeSerial: 'OWN', symbols: 'demo.elf', targetConfig: 'target/stm32.cfg', gdbPort: 3333, status: 'connected' as const, startedAt: now().toISOString() }] };
  const awareness = new SchedulerAwarenessService(
    scheduler,
    taskGraphs,
    workSessions,
    attempts,
    resources,
    interlocks,
    serial,
    debug
  );
  const executor = new TaskExecutionCoordinator(
    taskGraphs,
    scheduler,
    resources,
    interlocks,
    awareness
  );
  return { root, workSessions, sessionA, sessionB, taskGraphs, attempts, resources, interlocks, scheduler, awareness, executor };
}

test('scheduler awareness marks canonical hardware resource busy across sibling Work Sessions', async t => {
  const fx = await fixture(t);
  const { objective, task } = await runWithWorkSession(fx.sessionA.id, async () => {
    const objective = await fx.taskGraphs.create({ name: 'resource', objective: 'wait for probe' });
    const task = await fx.taskGraphs.addTask(objective.id, {
      title: 'flash',
      concurrency: { operation: 'hardware.debug-probe', key: 'debug-probe:ABC' },
      execution: EXECUTION
    });
    return { objective, task };
  });

  const lease = await runWithWorkSession(fx.sessionB.id, () =>
    fx.resources.acquire('debug-probe:ABC', 'debugging')
  );

  await runWithWorkSession(fx.sessionA.id, async () => {
    const snapshot = await fx.awareness.snapshot(objective.id);
    assert.equal(snapshot.plan[0]?.task.id, task.id);
    assert.equal(snapshot.plan[0]?.availability, 'waiting-resource');
    assert.equal(snapshot.plan[0]?.waitReason, 'RESOURCE_BUSY');
    assert.equal(snapshot.plan[0]?.blockingResources?.[0]?.resourceId, 'debug-probe:ABC');
    assert.equal(snapshot.plan[0]?.blockingResources?.[0]?.ownerId, 'other-session');

    await assert.rejects(
      fx.executor.execute(objective.id, task.id, async () => 'must-not-run'),
      /TASK_WAITING_RESOURCE/
    );
    assert.equal((await fx.taskGraphs.get(objective.id)).tasks[0]?.status, 'ready');
  });

  await runWithWorkSession(fx.sessionB.id, () => fx.resources.release(lease.id));
});

test('scheduler awareness uses Work Session worktree/build ownership without a global lock', async t => {
  const fx = await fixture(t);
  await fx.workSessions.updateProject(fx.sessionB.id, {
    workspace: 'projects',
    repoPath: 'repo',
    worktreePath: 'repo.rwmcp-b',
    buildDir: 'repo.rwmcp-b/build',
    branch: 'rwmcp/session/b'
  });

  await runWithWorkSession(fx.sessionA.id, async () => {
    const objective = await fx.taskGraphs.create({ name: 'sessions', objective: 'isolate source state' });
    const conflicting = await fx.taskGraphs.addTask(objective.id, {
      title: 'edit shared worktree',
      priority: 10,
      concurrency: { operation: 'source.edit', key: 'repo.rwmcp-b' },
      execution: EXECUTION
    });
    const independent = await fx.taskGraphs.addTask(objective.id, {
      title: 'isolated build',
      priority: 5,
      concurrency: { operation: 'build.isolated', key: 'repo.rwmcp-a/build' },
      execution: EXECUTION
    });

    const snapshot = await fx.awareness.snapshot(objective.id);
    const conflictPlan = snapshot.plan.find(item => item.task.id === conflicting.id);
    const independentPlan = snapshot.plan.find(item => item.task.id === independent.id);
    assert.equal(conflictPlan?.availability, 'waiting-session');
    assert.deepEqual(conflictPlan?.blockingSessionIds, [fx.sessionB.id]);
    assert.equal(independentPlan?.availability, 'ready');
    assert.ok(snapshot.sessions.some(item => item.id === fx.sessionB.id && item.worktreePath === 'repo.rwmcp-b'));
  });
});

test('node-exclusive work waits for active workflow interlock while unrelated shared work stays ready', async t => {
  const fx = await fixture(t);
  const interlock = await runWithWorkSession(fx.sessionB.id, () =>
    fx.interlocks.acquireWorkflow('other-session-build')
  );

  await runWithWorkSession(fx.sessionA.id, async () => {
    const objective = await fx.taskGraphs.create({ name: 'node', objective: 'respect node interlock' });
    const restart = await fx.taskGraphs.addTask(objective.id, {
      title: 'restart node',
      priority: 10,
      concurrency: { operation: 'node.restart', key: 'node' },
      execution: EXECUTION
    });
    const inspect = await fx.taskGraphs.addTask(objective.id, {
      title: 'inspect',
      priority: 5,
      concurrency: { operation: 'project.inspect' },
      execution: EXECUTION
    });

    const snapshot = await fx.awareness.snapshot(objective.id);
    assert.equal(snapshot.plan.find(item => item.task.id === restart.id)?.availability, 'waiting-node');
    assert.equal(snapshot.plan.find(item => item.task.id === inspect.id)?.availability, 'ready');
    assert.equal(snapshot.nodeInterlocks[0]?.id, interlock.id);
  });

  await runWithWorkSession(fx.sessionB.id, () => fx.interlocks.release(interlock.id));
});

test('scheduler awareness exposes bounded current-session attempts and serial/debug visibility', async t => {
  const fx = await fixture(t);
  await runWithWorkSession(fx.sessionA.id, async () => {
    const objective = await fx.taskGraphs.create({ name: 'snapshot', objective: 'compact live state' });
    const task = await fx.taskGraphs.addTask(objective.id, {
      title: 'inspect',
      concurrency: { operation: 'project.inspect' },
      execution: EXECUTION
    });
    const begun = await fx.attempts.begin(objective.id, task.id, 1);
    await fx.attempts.finish(begun.attempt.id, 'succeeded');

    const snapshot = await fx.awareness.snapshot(objective.id);
    assert.equal(snapshot.recentAttempts.length, 1);
    assert.equal(snapshot.recentAttempts[0]?.taskId, task.id);
    assert.equal(snapshot.serialSessions[0]?.resourceId, 'serial:COM9');
    assert.equal(snapshot.debugSessions[0]?.resourceId, 'debug-probe:OWN');
    assert.ok(snapshot.sessions.length >= 2);
  });
});


test('scheduler awareness honors canonical project-variant locks without blocking unrelated work', async t => {
  const fx = await fixture(t);
  const key = 'project-variant:keil:projects:repo:main.uvprojx:TargetA';

  const { objective, locked, free } = await runWithWorkSession(fx.sessionA.id, async () => {
    const objective = await fx.taskGraphs.create({ name: 'variant', objective: 'serialize shared Keil output' });
    const locked = await fx.taskGraphs.addTask(objective.id, {
      title: 'Keil target A',
      priority: 10,
      concurrency: { operation: 'build.keil-shared-output', key },
      execution: EXECUTION
    });
    const free = await fx.taskGraphs.addTask(objective.id, {
      title: 'Inspect project',
      priority: 5,
      concurrency: { operation: 'project.inspect' },
      execution: EXECUTION
    });
    return { objective, locked, free };
  });

  const lease = await runWithWorkSession(fx.sessionB.id, () =>
    fx.resources.acquire(key, 'building')
  );

  await runWithWorkSession(fx.sessionA.id, async () => {
    const snapshot = await fx.awareness.snapshot(objective.id);
    assert.equal(snapshot.plan.find(item => item.task.id === locked.id)?.availability, 'waiting-resource');
    assert.equal(snapshot.plan.find(item => item.task.id === locked.id)?.blockingResources?.[0]?.resourceId, key);
    assert.equal(snapshot.plan.find(item => item.task.id === free.id)?.availability, 'ready');
  });

  await runWithWorkSession(fx.sessionB.id, () => fx.resources.release(lease.id));
});
