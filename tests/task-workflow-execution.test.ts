import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EngineeringResourceManager } from '../src/adapters/engineering/resource-manager.js';
import type { EngineeringWorkflowEngine } from '../src/adapters/engineering/workflow-engine.js';
import { EngineeringWorkflowExecutionService } from '../src/engineering-workflow-execution.js';
import { NodeInterlockStore } from '../src/node-interlock.js';
import { QualityObservationStore } from '../src/quality-learning.js';
import { runWithWorkSession } from '../src/security/execution-context.js';
import { TaskExecutionCoordinator } from '../src/task-executor.js';
import { TaskAttemptStore } from '../src/task-attempt-store.js';
import { DeterministicTaskScheduler, TaskGraphStore } from '../src/task-graph.js';
import { TaskWorkflowExecutionService } from '../src/task-workflow-execution.js';
import { WorkflowRunStore } from '../src/workflow-run-store.js';

const SESSION = '55555555-5555-4555-8555-555555555555';

async function fixture(
  t: test.TestContext,
  run: (...args: unknown[]) => Promise<unknown>
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-task-workflow-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  let tick = 0;
  const now = () => new Date(1_830_000_000_000 + tick++ * 1000);

  const taskGraphs = new TaskGraphStore('openai-tunnel', {
    file: path.join(root, 'objectives.json'),
    now
  });
  const scheduler = new DeterministicTaskScheduler(taskGraphs);
  const resources = new EngineeringResourceManager('openai-tunnel');
  const interlocks = new NodeInterlockStore('openai-tunnel', {
    file: path.join(root, 'interlocks.json'),
    now,
    pid: 5656,
    pidAlive: () => true
  });
  const taskExecutor = new TaskExecutionCoordinator(taskGraphs, scheduler, resources, interlocks);
  const taskAttempts = new TaskAttemptStore('openai-tunnel', {
    file: path.join(root, 'task-attempts.json'),
    now
  });

  const workflowRuns = new WorkflowRunStore('openai-tunnel', {
    file: path.join(root, 'workflow-runs.json'),
    now
  });
  const quality = new QualityObservationStore('openai-tunnel', {
    file: path.join(root, 'quality.json'),
    settingsFile: path.join(root, 'quality-settings.json'),
    now
  });
  const engine = { run } as unknown as EngineeringWorkflowEngine;
  const workflowExecution = new EngineeringWorkflowExecutionService(
    engine,
    workflowRuns,
    quality,
    interlocks
  );
  const taskWorkflowExecution = new TaskWorkflowExecutionService(
    taskGraphs,
    taskExecutor,
    workflowExecution,
    taskAttempts
  );
  return {
    taskGraphs,
    taskAttempts,
    workflowRuns,
    quality,
    interlocks,
    taskWorkflowExecution
  };
}

function binding() {
  return {
    kind: 'engineering-workflow' as const,
    workspace: 'projects',
    projectPath: 'firmware/demo',
    workflow: 'firmware.build',
    parameters: { variant: 'debug' }
  };
}

test('typed task binding succeeds only after shared workflow execution succeeds', async t => {
  const fx = await fixture(t, async () => ({
    workflow: 'firmware.build',
    status: 'succeeded',
    plan: { steps: [] },
    steps: []
  }));

  await runWithWorkSession(SESSION, async () => {
    const objective = await fx.taskGraphs.create({
      name: 'Build objective',
      objective: 'Build through scheduler'
    });
    const task = await fx.taskGraphs.addTask(objective.id, {
      title: 'Build firmware',
      concurrency: { operation: 'project.inspect' },
      execution: binding()
    });

    const output = await fx.taskWorkflowExecution.execute(objective.id, task.id);
    assert.equal(output.task.status, 'succeeded');
    assert.equal((output.output.workflowRun as { status?: string }).status, 'succeeded');

    const persisted = await fx.taskGraphs.get(objective.id);
    assert.equal(persisted.tasks[0]?.status, 'succeeded');
    assert.equal(persisted.tasks[0]?.execution?.workflow, 'firmware.build');

    const runs = await fx.workflowRuns.list();
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.status, 'succeeded');
    const observations = await fx.quality.list();
    assert.equal(observations[0]?.candidateState, 'pending-owner-review');
    assert.deepEqual(await fx.interlocks.listActive(), []);
  });
});

test('blocked typed workflow fails the task instead of reporting fake task success', async t => {
  const fx = await fixture(t, async () => ({
    workflow: 'firmware.build',
    status: 'blocked',
    plan: { blockers: ['toolchain missing'] },
    steps: []
  }));

  await runWithWorkSession(SESSION, async () => {
    const objective = await fx.taskGraphs.create({
      name: 'Blocked objective',
      objective: 'Do not claim success'
    });
    const task = await fx.taskGraphs.addTask(objective.id, {
      title: 'Build firmware',
      concurrency: { operation: 'project.inspect' },
      execution: binding()
    });

    await assert.rejects(
      fx.taskWorkflowExecution.execute(objective.id, task.id),
      /TASK_WORKFLOW_NOT_SUCCEEDED: workflow status=blocked/
    );

    const persisted = await fx.taskGraphs.get(objective.id);
    assert.equal(persisted.tasks[0]?.status, 'failed');
    assert.match(persisted.tasks[0]?.error ?? '', /workflow status=blocked/);

    const runs = await fx.workflowRuns.list();
    assert.equal(runs[0]?.status, 'blocked');
    const observations = await fx.quality.list();
    assert.equal(observations[0]?.candidateState, 'ineligible');
    assert.equal(observations[0]?.outcome, 'blocked');
    assert.deepEqual(await fx.interlocks.listActive(), []);
  });
});


test('same task generation replays durable attempt instead of executing workflow twice', async t => {
  let calls = 0;
  const fx = await fixture(t, async () => {
    calls += 1;
    return {
      workflow: 'firmware.build',
      status: 'succeeded',
      plan: { steps: [] },
      steps: []
    };
  });

  await runWithWorkSession(SESSION, async () => {
    const objective = await fx.taskGraphs.create({
      name: 'Idempotent objective',
      objective: 'Do not duplicate execution'
    });
    const task = await fx.taskGraphs.addTask(objective.id, {
      title: 'Build once',
      concurrency: { operation: 'project.inspect' },
      execution: binding()
    });

    const first = await fx.taskWorkflowExecution.execute(objective.id, task.id);
    const second = await fx.taskWorkflowExecution.execute(objective.id, task.id);

    assert.equal(first.replayed, false);
    assert.equal(second.replayed, true);
    assert.equal(second.attempt.id, first.attempt.id);
    assert.equal(second.attempt.generation, 1);
    assert.equal(calls, 1);
    assert.equal((await fx.workflowRuns.list()).length, 1);
    assert.equal((await fx.taskAttempts.list({ taskId: task.id })).length, 1);
  });
});

test('cancel before dispatch is terminal for one generation and explicit retry creates the next generation', async t => {
  let calls = 0;
  const fx = await fixture(t, async () => {
    calls += 1;
    return {
      workflow: 'firmware.build',
      status: 'succeeded',
      plan: { steps: [] },
      steps: []
    };
  });

  await runWithWorkSession(SESSION, async () => {
    const objective = await fx.taskGraphs.create({
      name: 'Retry objective',
      objective: 'Retry only by explicit generation advance'
    });
    const task = await fx.taskGraphs.addTask(objective.id, {
      title: 'Build after retry',
      concurrency: { operation: 'project.inspect' },
      execution: binding()
    });

    const cancelled = await fx.taskWorkflowExecution.cancel(objective.id, task.id);
    assert.equal(cancelled.preempted, true);
    assert.equal(cancelled.task.status, 'cancelled');
    assert.equal(cancelled.attempt.status, 'cancelled');
    assert.equal(cancelled.attempt.generation, 1);

    const replay = await fx.taskWorkflowExecution.execute(objective.id, task.id);
    assert.equal(replay.replayed, true);
    assert.equal(replay.attempt.status, 'cancelled');
    assert.equal(calls, 0);

    const retried = await fx.taskWorkflowExecution.retry(objective.id, task.id);
    assert.equal(retried.task.generation, 2);
    assert.equal(retried.task.status, 'ready');

    const executed = await fx.taskWorkflowExecution.execute(objective.id, task.id);
    assert.equal(executed.task.status, 'succeeded');
    assert.equal(executed.attempt.generation, 2);
    assert.equal(calls, 1);

    const attempts = await fx.taskAttempts.list({ taskId: task.id });
    assert.deepEqual(attempts.map(item => [item.generation, item.status]), [
      [2, 'succeeded'],
      [1, 'cancelled']
    ]);
  });
});

test('running cancellation records intent without falsely claiming provider preemption', async t => {
  let entered!: () => void;
  const running = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fx = await fixture(t, async () => {
    entered();
    await gate;
    return {
      workflow: 'firmware.build',
      status: 'succeeded',
      plan: { steps: [] },
      steps: []
    };
  });

  await runWithWorkSession(SESSION, async () => {
    const objective = await fx.taskGraphs.create({
      name: 'Cancel running',
      objective: 'Record cancellation intent honestly'
    });
    const task = await fx.taskGraphs.addTask(objective.id, {
      title: 'Long build',
      concurrency: { operation: 'project.inspect' },
      execution: binding()
    });

    const execution = fx.taskWorkflowExecution.execute(objective.id, task.id);
    await running;

    const cancellation = await fx.taskWorkflowExecution.cancel(objective.id, task.id);
    assert.equal(cancellation.cancellationRequested, true);
    assert.equal(cancellation.preempted, false);
    assert.equal(cancellation.attempt?.status, 'running');
    assert.ok(cancellation.attempt?.cancelRequestedAt);

    release();
    const completed = await execution;
    assert.equal(completed.task.status, 'succeeded');
    assert.equal(completed.attempt.status, 'succeeded');
    assert.ok(completed.attempt.cancelRequestedAt);
  });
});
