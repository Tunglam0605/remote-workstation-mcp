import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EngineeringResourceManager } from '../src/adapters/engineering/resource-manager.js';
import { NodeInterlockStore } from '../src/node-interlock.js';
import { ObjectiveProgressService } from '../src/objective-progress.js';
import { runWithWorkSession } from '../src/security/execution-context.js';
import { SchedulerAwarenessService } from '../src/scheduler-awareness.js';
import { TaskAttemptStore } from '../src/task-attempt-store.js';
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-objective-progress-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  let tick = 0;
  const now = () => new Date(1_860_000_000_000 + tick++ * 1000);
  const workSessions = new WorkSessionStore('openai-tunnel', {
    file: path.join(root, 'sessions.json'),
    now
  });
  const sessionA = await workSessions.create({ name: 'MAIN', workspace: 'projects', projectPath: 'repo' });
  const sessionB = await workSessions.create({ name: 'FW', workspace: 'projects', projectPath: 'repo' });
  await workSessions.updateProject(sessionA.id, {
    workspace: 'projects',
    repoPath: 'repo',
    worktreePath: 'repo.rwmcp-main',
    buildDir: 'repo.rwmcp-main/build',
    branch: 'rwmcp/session/main',
    commit: 'abc123'
  });

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
    pid: 8686,
    pidAlive: () => true
  });
  const scheduler = new DeterministicTaskScheduler(taskGraphs);
  const serial = { list: () => [] };
  const debug = { list: () => [] };
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
  const progress = new ObjectiveProgressService(
    taskGraphs,
    attempts,
    awareness,
    workSessions,
    { now }
  );
  return { workSessions, sessionA, sessionB, taskGraphs, attempts, resources, interlocks, progress };
}

test('Objective progress aggregates durable task state, blockers, latest failure and mechanically actionable work', async t => {
  const fx = await fixture(t);
  await runWithWorkSession(fx.sessionA.id, async () => {
    const objective = await fx.taskGraphs.create({ name: 'B300 acceptance', objective: 'Aggregate project state' });
    const done = await fx.taskGraphs.addTask(objective.id, {
      title: 'inspect',
      priority: 20,
      concurrency: { operation: 'project.inspect' },
      execution: EXECUTION
    });
    const failed = await fx.taskGraphs.addTask(objective.id, {
      title: 'build',
      priority: 15,
      concurrency: { operation: 'project.inspect' },
      execution: EXECUTION
    });
    const blocked = await fx.taskGraphs.addTask(objective.id, {
      title: 'flash',
      dependencies: [failed.id],
      priority: 10,
      concurrency: { operation: 'hardware.debug-probe', key: 'debug-probe:ABC' },
      execution: EXECUTION
    });
    const ready = await fx.taskGraphs.addTask(objective.id, {
      title: 'documentation',
      priority: 5,
      concurrency: { operation: 'project.inspect' },
      execution: EXECUTION
    });

    await fx.taskGraphs.startTask(objective.id, done.id);
    await fx.taskGraphs.finishTask(objective.id, done.id, 'succeeded');
    const doneAttempt = (await fx.attempts.begin(objective.id, done.id, 1)).attempt;
    await fx.attempts.finish(doneAttempt.id, 'succeeded');

    await fx.taskGraphs.startTask(objective.id, failed.id);
    await fx.taskGraphs.finishTask(objective.id, failed.id, 'failed', 'compile error');
    const failedAttempt = (await fx.attempts.begin(objective.id, failed.id, 1)).attempt;
    await fx.attempts.finish(failedAttempt.id, 'failed', { error: 'compile error' });

    const summary = await fx.progress.summary(objective.id);
    assert.deepEqual(summary.progress, {
      total: 4,
      succeeded: 1,
      failed: 1,
      blocked: 1,
      cancelled: 0,
      running: 0,
      ready: 1,
      pending: 0,
      succeededRatio: 0.25
    });
    assert.equal(summary.latestFailure?.taskId, failed.id);
    assert.equal(summary.latestFailure?.taskTitle, 'build');
    assert.equal(summary.latestFailure?.error, 'compile error');
    assert.ok(summary.blockers.some(item => item.taskId === failed.id && item.kind === 'task-failed'));
    assert.ok(summary.blockers.some(item => item.taskId === blocked.id && item.kind === 'task-blocked'));
    assert.deepEqual(summary.nextActionable.map(item => item.taskId), [ready.id]);
    assert.equal(summary.workSession?.id, fx.sessionA.id);
    assert.equal(summary.workSession?.worktreePath, 'repo.rwmcp-main');
    assert.equal(summary.workSession?.commit, 'abc123');
    assert.equal(summary.semantics.mechanicallyDerived, true);
    assert.equal(summary.semantics.recommendation, false);
    assert.equal(summary.semantics.authority, 'read-only-summary');
  });
});

test('Objective progress surfaces resource waiting without treating it as task failure', async t => {
  const fx = await fixture(t);
  const { objective, task } = await runWithWorkSession(fx.sessionA.id, async () => {
    const objective = await fx.taskGraphs.create({ name: 'resource wait', objective: 'Wait for ST-Link' });
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
    const summary = await fx.progress.summary(objective.id);
    assert.equal(summary.progress.ready, 1);
    assert.equal(summary.progress.failed, 0);
    assert.equal(summary.nextActionable.length, 0);
    const blocker = summary.blockers.find(item => item.taskId === task.id);
    assert.equal(blocker?.kind, 'waiting-resource');
    assert.equal(blocker?.reason, 'RESOURCE_BUSY');
    assert.deepEqual(blocker?.resourceIds, ['debug-probe:ABC']);
    assert.ok(summary.resources.some(item => item.resourceId === 'debug-probe:ABC' && item.ownerId === 'other-session'));
  });

  await runWithWorkSession(fx.sessionB.id, () => fx.resources.release(lease.id));
});

test('Objective progress keeps aggregate counts complete while bounding task and actionable details', async t => {
  const fx = await fixture(t);
  await runWithWorkSession(fx.sessionA.id, async () => {
    const objective = await fx.taskGraphs.create({ name: 'bounded', objective: 'Bound summary details' });
    for (let index = 0; index < 6; index += 1) {
      await fx.taskGraphs.addTask(objective.id, {
        title: `task-${index}`,
        priority: 10 - index,
        concurrency: { operation: 'project.inspect' },
        execution: EXECUTION
      });
    }

    const summary = await fx.progress.summary(objective.id, {
      taskLimit: 2,
      blockerLimit: 1,
      actionableLimit: 2
    });
    assert.equal(summary.progress.total, 6);
    assert.equal(summary.progress.ready, 6);
    assert.equal(summary.tasks.length, 2);
    assert.equal(summary.omittedTaskCount, 4);
    assert.equal(summary.nextActionable.length, 2);
    assert.deepEqual(summary.nextActionable.map(item => item.title), ['task-0', 'task-1']);
    assert.equal(summary.blockers.length, 0);
  });
});
