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
import { SchedulerAwarenessService } from '../src/scheduler-awareness.js';
import { TaskExecutionCoordinator } from '../src/task-executor.js';
import { TaskAttemptStore } from '../src/task-attempt-store.js';
import { DeterministicTaskScheduler, TaskGraphStore } from '../src/task-graph.js';
import { TaskWorkflowExecutionService } from '../src/task-workflow-execution.js';
import { WorkflowRunStore } from '../src/workflow-run-store.js';
import { WorkerProviderRegistry } from '../src/worker-provider.js';
import { WorkSessionStore } from '../src/work-session.js';
import type { WorktreeState } from '../src/worktree-manager.js';

const SESSION = '55555555-5555-4555-8555-555555555555';

async function fixture(
  t: test.TestContext,
  run: (...args: unknown[]) => Promise<unknown>,
  options: {
    worktreeStatus?: (sessionId: string) => Promise<WorktreeState>;
    executionPolicy?: any;
    desktopNotifications?: any;
  } = {}
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
  const taskAttempts = new TaskAttemptStore('openai-tunnel', {
    file: path.join(root, 'task-attempts.json'),
    now
  });
  const workSessions = new WorkSessionStore('openai-tunnel', {
    file: path.join(root, 'work-sessions.json'),
    now
  });
  const workerProviders = new WorkerProviderRegistry();
  const awareness = new SchedulerAwarenessService(
    scheduler,
    taskGraphs,
    workSessions,
    taskAttempts,
    resources,
    interlocks,
    { list: () => [] },
    { list: () => [] },
    workerProviders
  );
  const taskExecutor = new TaskExecutionCoordinator(taskGraphs, scheduler, resources, interlocks, awareness);

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
    taskAttempts,
    workerProviders,
    workSessions,
    options.worktreeStatus ? { status: options.worktreeStatus } : undefined,
    options.executionPolicy,
    options.desktopNotifications
  );
  return {
    taskGraphs,
    taskAttempts,
    workflowRuns,
    quality,
    interlocks,
    workerProviders,
    workSessions,
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

function workerBinding(providerId = 'codex-local') {
  return {
    kind: 'worker-provider' as const,
    providerId
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
    assert.equal(persisted.tasks[0]?.execution?.kind, 'engineering-workflow');
    if (persisted.tasks[0]?.execution?.kind === 'engineering-workflow') {
      assert.equal(persisted.tasks[0].execution.workflow, 'firmware.build');
    }

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


test('worker-provider task dispatches through the coordinator and replays one durable attempt per generation', async t => {
  let calls = 0;
  let captured: any;
  const fx = await fixture(t, async () => {
    throw new Error('engineering workflow path should not run');
  });
  fx.workerProviders.register({
    descriptor: {
      id: 'codex-local',
      kind: 'codex',
      displayName: 'Codex Local',
      worktreeAssignment: false,
      progressReporting: true,
      cancellationIntent: true
    },
    status: async () => ({ availability: 'available' as const, detail: 'ready' }),
    dispatch: async request => {
      calls += 1;
      captured = request;
      return { status: 'succeeded' as const, runId: 'worker-run-1', summary: 'completed' };
    }
  });
  const session = await fx.workSessions.create({
    name: 'worker-session',
    workspace: 'projects',
    projectPath: 'repo',
    objective: 'delegate bounded work'
  });

  await runWithWorkSession(session.id, async () => {
    const objective = await fx.taskGraphs.create({
      name: 'Worker objective',
      objective: 'Delegate one persisted task'
    });
    const task = await fx.taskGraphs.addTask(objective.id, {
      title: 'Review source tree',
      description: 'Inspect the isolated project and report the bounded result.',
      concurrency: { operation: 'project.inspect' },
      execution: workerBinding()
    });

    const first = await fx.taskWorkflowExecution.execute(objective.id, task.id);
    const replay = await fx.taskWorkflowExecution.execute(objective.id, task.id);

    assert.equal(first.task.status, 'succeeded');
    assert.equal(first.replayed, false);
    assert.equal(first.attempt.providerId, 'codex-local');
    assert.equal(first.attempt.providerRunId, 'worker-run-1');
    assert.equal((first.output as { status?: string }).status, 'succeeded');
    assert.equal(replay.replayed, true);
    assert.equal(replay.attempt.id, first.attempt.id);
    assert.equal(calls, 1);
    assert.equal(captured.workSessionId, session.id);
    assert.equal(captured.objective.id, objective.id);
    assert.equal(captured.task.id, task.id);
    assert.equal(captured.task.generation, 1);
    assert.equal(captured.project.workspace, 'projects');
    assert.equal(captured.project.projectPath, 'repo');
    assert.equal((await fx.taskAttempts.list({ taskId: task.id })).length, 1);
  });
});



test('Codex worker terminal outcomes emit bounded desktop notifications without affecting task authority', async t => {
  const notices: any[] = [];
  const desktopNotifications = {
    async notify(notification: any) {
      notices.push(notification);
      return { delivered: true };
    }
  };
  const fx = await fixture(t, async () => {
    throw new Error('engineering workflow path should not run');
  }, { desktopNotifications });
  let nextStatus: 'succeeded' | 'blocked' = 'succeeded';
  fx.workerProviders.register({
    descriptor: {
      id: 'codex-local',
      kind: 'codex',
      displayName: 'Codex Local',
      worktreeAssignment: false,
      progressReporting: false,
      cancellationIntent: false
    },
    status: async () => ({ availability: 'available' as const }),
    dispatch: async () => nextStatus === 'succeeded'
      ? ({ status: 'succeeded' as const, runId: 'notify-success' })
      : ({ status: 'blocked' as const, runId: 'notify-blocked', summary: 'workspace is read-only' })
  });
  const session = await fx.workSessions.create({
    name: 'desktop-notification-session',
    workspace: 'projects',
    projectPath: 'repo'
  });

  await runWithWorkSession(session.id, async () => {
    const successObjective = await fx.taskGraphs.create({ name: 'Notify success', objective: 'Complete one task' });
    const successTask = await fx.taskGraphs.addTask(successObjective.id, {
      title: 'Small safe edit',
      concurrency: { operation: 'project.inspect' },
      execution: workerBinding('codex-local')
    });
    const success = await fx.taskWorkflowExecution.execute(successObjective.id, successTask.id);
    assert.equal(success.attempt.status, 'succeeded');
    assert.equal(notices[0]?.title, 'Codex task hoàn tất');
    assert.match(notices[0]?.body ?? '', /Small safe edit/);

    nextStatus = 'blocked';
    const blockedObjective = await fx.taskGraphs.create({ name: 'Notify blocked', objective: 'Block safely' });
    const blockedTask = await fx.taskGraphs.addTask(blockedObjective.id, {
      title: 'Read-only edit',
      concurrency: { operation: 'project.inspect' },
      execution: workerBinding('codex-local')
    });
    await assert.rejects(fx.taskWorkflowExecution.execute(blockedObjective.id, blockedTask.id), /TASK_WORKER_NOT_SUCCEEDED/);
    assert.equal(notices[1]?.title, 'Codex task bị chặn');
    assert.equal(notices[1]?.kind, 'warning');
  });
});

test('worktree-required worker fails closed before provider dispatch and succeeds only after explicit retry with worktree context', async t => {
  let calls = 0;
  const fx = await fixture(t, async () => {
    throw new Error('engineering workflow path should not run');
  });
  fx.workerProviders.register({
    descriptor: {
      id: 'codex-worktree',
      kind: 'codex',
      displayName: 'Codex Worktree',
      worktreeAssignment: true,
      progressReporting: false,
      cancellationIntent: false
    },
    status: async () => ({ availability: 'available' as const }),
    dispatch: async () => {
      calls += 1;
      return { status: 'succeeded' as const, runId: 'worker-run-worktree' };
    }
  });
  const session = await fx.workSessions.create({
    name: 'worker-worktree-session',
    workspace: 'projects',
    projectPath: 'repo'
  });

  await runWithWorkSession(session.id, async () => {
    const objective = await fx.taskGraphs.create({
      name: 'Worktree guard',
      objective: 'Require isolation before worker dispatch'
    });
    const task = await fx.taskGraphs.addTask(objective.id, {
      title: 'Edit isolated source',
      concurrency: { operation: 'source.edit', key: 'repo' },
      execution: workerBinding('codex-worktree')
    });

    await assert.rejects(
      fx.taskWorkflowExecution.execute(objective.id, task.id),
      /TASK_WAITING_SESSION: WORKER_WORKTREE_REQUIRED/
    );
    assert.equal(calls, 0);
    assert.equal(await fx.taskAttempts.getForGeneration(objective.id, task.id, 1), undefined);
    assert.equal((await fx.taskGraphs.get(objective.id)).tasks.find(item => item.id === task.id)?.status, 'ready');

    await fx.workSessions.updateProject(session.id, {
      worktreePath: 'repo.rwmcp-worker',
      buildDir: 'repo.rwmcp-worker/build',
      branch: 'rwmcp/session/worker',
      commit: '0123456789abcdef'
    });

    const completed = await fx.taskWorkflowExecution.execute(objective.id, task.id);
    assert.equal(completed.task.status, 'succeeded');
    assert.equal(completed.attempt.generation, 1);
    assert.equal(completed.attempt.providerRunId, 'worker-run-worktree');
    assert.equal(calls, 1);
  });
});

test('unavailable or blocked worker providers never produce fake task success', async t => {
  let unavailableDispatchCalls = 0;
  const fx = await fixture(t, async () => {
    throw new Error('engineering workflow path should not run');
  });
  fx.workerProviders.register({
    descriptor: {
      id: 'offline-worker',
      kind: 'custom',
      displayName: 'Offline Worker',
      worktreeAssignment: false,
      progressReporting: false,
      cancellationIntent: false
    },
    status: async () => ({ availability: 'unavailable' as const, detail: 'offline' }),
    dispatch: async () => {
      unavailableDispatchCalls += 1;
      return { status: 'succeeded' as const };
    }
  });
  fx.workerProviders.register({
    descriptor: {
      id: 'blocked-worker',
      kind: 'custom',
      displayName: 'Blocked Worker',
      worktreeAssignment: false,
      progressReporting: false,
      cancellationIntent: false
    },
    status: async () => ({ availability: 'available' as const }),
    dispatch: async () => ({ status: 'blocked' as const, runId: 'blocked-run', summary: 'needs owner input' })
  });
  const session = await fx.workSessions.create({
    name: 'worker-failure-session',
    workspace: 'projects',
    projectPath: 'repo'
  });

  await runWithWorkSession(session.id, async () => {
    const objective = await fx.taskGraphs.create({
      name: 'Provider failure isolation',
      objective: 'Never claim worker success on provider failure'
    });
    const offline = await fx.taskGraphs.addTask(objective.id, {
      title: 'Offline provider task',
      concurrency: { operation: 'project.inspect' },
      execution: workerBinding('offline-worker')
    });
    const blocked = await fx.taskGraphs.addTask(objective.id, {
      title: 'Blocked provider task',
      concurrency: { operation: 'project.inspect' },
      execution: workerBinding('blocked-worker')
    });

    await assert.rejects(
      fx.taskWorkflowExecution.execute(objective.id, offline.id),
      /TASK_WAITING_PROVIDER: WORKER_PROVIDER_UNAVAILABLE/
    );
    assert.equal(unavailableDispatchCalls, 0);
    assert.equal(await fx.taskAttempts.getForGeneration(objective.id, offline.id, 1), undefined);
    assert.equal((await fx.taskGraphs.get(objective.id)).tasks.find(item => item.id === offline.id)?.status, 'ready');

    await assert.rejects(
      fx.taskWorkflowExecution.execute(objective.id, blocked.id),
      /TASK_WORKER_NOT_SUCCEEDED: provider=blocked-worker status=blocked/
    );
    const blockedAttempt = await fx.taskAttempts.getForGeneration(objective.id, blocked.id, 1);
    assert.equal(blockedAttempt?.status, 'blocked');
    assert.equal(blockedAttempt?.providerId, 'blocked-worker');
    assert.equal(blockedAttempt?.providerRunId, 'blocked-run');
    assert.equal((await fx.taskGraphs.get(objective.id)).tasks.find(item => item.id === blocked.id)?.status, 'failed');
  });
});


test('worktree-bound provider receives live WorktreeManager metadata instead of stale capsule commit', async t => {
  let captured: any;
  const liveCommit = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const fx = await fixture(
    t,
    async () => {
      throw new Error('engineering workflow path should not run');
    },
    {
      worktreeStatus: async sessionId => ({
        sessionId,
        workspace: 'projects',
        repoPath: 'repo',
        worktreePath: 'repo.rwmcp-live',
        branch: 'rwmcp/session/live',
        commit: liveCommit,
        buildDir: 'repo.rwmcp-live/build',
        dirty: false
      })
    }
  );
  fx.workerProviders.register({
    descriptor: {
      id: 'live-worktree-worker',
      kind: 'custom',
      displayName: 'Live Worktree Worker',
      worktreeAssignment: true,
      progressReporting: false,
      cancellationIntent: false
    },
    status: async () => ({ availability: 'available' as const }),
    dispatch: async request => {
      captured = request;
      return { status: 'succeeded' as const, runId: 'live-worktree-run' };
    }
  });
  const session = await fx.workSessions.create({
    name: 'live-worktree-session',
    workspace: 'projects',
    projectPath: 'repo'
  });
  await fx.workSessions.updateProject(session.id, {
    repoPath: 'repo',
    worktreePath: 'repo.rwmcp-stale',
    buildDir: 'repo.rwmcp-stale/build',
    branch: 'rwmcp/session/stale',
    commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  });

  await runWithWorkSession(session.id, async () => {
    const objective = await fx.taskGraphs.create({
      name: 'Live worktree metadata',
      objective: 'Dispatch against live isolated Git state'
    });
    const task = await fx.taskGraphs.addTask(objective.id, {
      title: 'Delegate isolated work',
      concurrency: { operation: 'source.edit', key: 'repo.rwmcp-live' },
      execution: workerBinding('live-worktree-worker')
    });

    const output = await fx.taskWorkflowExecution.execute(objective.id, task.id);
    assert.equal(output.task.status, 'succeeded');
    assert.equal(captured.project.worktreePath, 'repo.rwmcp-live');
    assert.equal(captured.project.buildDir, 'repo.rwmcp-live/build');
    assert.equal(captured.project.branch, 'rwmcp/session/live');
    assert.equal(captured.project.commit, liveCommit);
    assert.notEqual(captured.project.commit, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  });
});


test('Codex capacity failure falls through to Antigravity and records the provider trace', async t => {
  const events: string[] = [];
  const executionPolicy = {
    async settings() {
      return { execution: { codexEnabled: true, antigravityEnabled: true, codexFallback: 'rwmcp-only' } };
    },
    async status() {
      return { effectiveMode: 'both', fallbackActive: false };
    },
    async beforeCodexDispatch(sessionId: string, options?: { deferFallback?: boolean }) {
      events.push(`before:${sessionId}:${options?.deferFallback === true}`);
      return {};
    },
    async activateSessionFallback(sessionId: string, reason: string) {
      events.push(`fallback:${sessionId}:${reason}`);
    }
  };
  const notices: any[] = [];
  const desktopNotifications = {
    async notify(notification: any) { notices.push(notification); return { delivered: true }; }
  };
  const fx = await fixture(t, async () => {
    throw new Error('engineering workflow path should not run');
  }, { executionPolicy, desktopNotifications });

  fx.workerProviders.register({
    descriptor: {
      id: 'codex-local',
      kind: 'codex',
      displayName: 'Codex Local',
      worktreeAssignment: false,
      progressReporting: false,
      cancellationIntent: false
    },
    status: async () => ({ availability: 'available' as const }),
    dispatch: async () => ({
      status: 'blocked' as const,
      runId: 'codex-limit-run',
      summary: 'CODEX_LIMIT_REACHED; HTTP 429 usage limit reached'
    })
  });
  fx.workerProviders.register({
    descriptor: {
      id: 'antigravity-local',
      kind: 'antigravity',
      displayName: 'Antigravity Local',
      worktreeAssignment: false,
      progressReporting: false,
      cancellationIntent: false
    },
    status: async () => ({ availability: 'available' as const }),
    dispatch: async () => ({
      status: 'succeeded' as const,
      runId: 'anti-success-run',
      summary: 'implemented with alternate worker'
    })
  });

  const session = await fx.workSessions.create({
    name: 'symmetric-fallback-session',
    workspace: 'projects',
    projectPath: 'repo'
  });

  await runWithWorkSession(session.id, async () => {
    const objective = await fx.taskGraphs.create({
      name: 'Symmetric worker objective',
      objective: 'Use alternate AI worker before RWMCP fallback'
    });
    const task = await fx.taskGraphs.addTask(objective.id, {
      title: 'Bounded implementation',
      concurrency: { operation: 'project.inspect' },
      execution: workerBinding('codex-local')
    });

    const output = await fx.taskWorkflowExecution.execute(objective.id, task.id);
    assert.equal(output.task.status, 'succeeded');
    assert.deepEqual(events, [`before:${session.id}:true`]);

    const attempts = await fx.taskAttempts.list({ taskId: task.id });
    assert.equal(attempts[0]?.status, 'succeeded');
    assert.equal(attempts[0]?.providerId, 'antigravity-local');
    assert.deepEqual(
      attempts[0]?.providerAttempts?.map(item => [item.providerId, item.status]),
      [['codex-local', 'blocked'], ['antigravity-local', 'succeeded']]
    );
    assert.equal(notices[0]?.title, 'Antigravity task hoàn tất');
    assert.equal(notices[0]?.kind, 'success');
  });
});

test('all AI worker capacity failures activate Work Session RWMCP fallback after the full chain is exhausted', async t => {
  const events: string[] = [];
  const executionPolicy = {
    async settings() {
      return { execution: { codexEnabled: true, antigravityEnabled: true, codexFallback: 'rwmcp-only' } };
    },
    async status() {
      return { effectiveMode: 'both', fallbackActive: false };
    },
    async beforeCodexDispatch(sessionId: string, options?: { deferFallback?: boolean }) {
      events.push(`before:${sessionId}:${options?.deferFallback === true}`);
      return {};
    },
    async activateSessionFallback(sessionId: string, reason: string) {
      events.push(`fallback:${sessionId}:${reason}`);
    }
  };
  const notices: any[] = [];
  const desktopNotifications = {
    async notify(notification: any) { notices.push(notification); return { delivered: true }; }
  };
  const fx = await fixture(t, async () => {
    throw new Error('engineering workflow path should not run');
  }, { executionPolicy, desktopNotifications });

  fx.workerProviders.register({
    descriptor: {
      id: 'codex-local',
      kind: 'codex',
      displayName: 'Codex Local',
      worktreeAssignment: false,
      progressReporting: false,
      cancellationIntent: false
    },
    status: async () => ({ availability: 'available' as const }),
    dispatch: async () => ({
      status: 'blocked' as const,
      runId: 'codex-limit-run',
      summary: 'CODEX_LIMIT_REACHED; quota exhausted'
    })
  });
  fx.workerProviders.register({
    descriptor: {
      id: 'antigravity-local',
      kind: 'antigravity',
      displayName: 'Antigravity Local',
      worktreeAssignment: false,
      progressReporting: false,
      cancellationIntent: false
    },
    status: async () => ({ availability: 'available' as const }),
    dispatch: async () => ({
      status: 'blocked' as const,
      runId: 'anti-limit-run',
      summary: 'ANTIGRAVITY_LIMIT_REACHED; resource exhausted'
    })
  });

  const session = await fx.workSessions.create({
    name: 'all-workers-exhausted-session',
    workspace: 'projects',
    projectPath: 'repo'
  });

  await runWithWorkSession(session.id, async () => {
    const objective = await fx.taskGraphs.create({
      name: 'AI workers exhausted objective',
      objective: 'Fall back to direct RWMCP only after the AI worker chain is exhausted'
    });
    const task = await fx.taskGraphs.addTask(objective.id, {
      title: 'Bounded implementation',
      concurrency: { operation: 'project.inspect' },
      execution: workerBinding('codex-local')
    });

    await assert.rejects(
      fx.taskWorkflowExecution.execute(objective.id, task.id),
      /WORKER_FALLBACK_ACTIVE/
    );
    assert.deepEqual(events, [
      `before:${session.id}:true`,
      `fallback:${session.id}:workers-exhausted`
    ]);

    const attempts = await fx.taskAttempts.list({ taskId: task.id });
    assert.equal(attempts[0]?.status, 'blocked');
    assert.deepEqual(
      attempts[0]?.providerAttempts?.map(item => [item.providerId, item.status]),
      [['codex-local', 'blocked'], ['antigravity-local', 'blocked'], ['rwmcp-direct', 'blocked']]
    );
    assert.equal(notices[0]?.title, 'AI workers đã chuyển sang RWMCP');
    assert.equal(notices[0]?.kind, 'warning');
  });
});

test('ordinary worker task failure cross-falls to an alternate AI worker only when ownership remains safe', async t => {
  let antigravityCalls = 0;
  const executionPolicy = {
    async settings() {
      return { execution: { codexEnabled: true, antigravityEnabled: true, codexFallback: 'rwmcp-only' } };
    },
    async status() {
      return { effectiveMode: 'both', fallbackActive: false };
    },
    async beforeCodexDispatch() {
      return {};
    },
    async activateSessionFallback() {
      throw new Error('fallback should not activate for ordinary task failure');
    }
  };
  const fx = await fixture(t, async () => {
    throw new Error('engineering workflow path should not run');
  }, { executionPolicy });

  fx.workerProviders.register({
    descriptor: {
      id: 'codex-local',
      kind: 'codex',
      displayName: 'Codex Local',
      worktreeAssignment: false,
      progressReporting: false,
      cancellationIntent: false
    },
    status: async () => ({ availability: 'available' as const }),
    dispatch: async () => ({
      status: 'failed' as const,
      runId: 'codex-build-fail',
      summary: 'compile failed with exit code 2'
    })
  });
  fx.workerProviders.register({
    descriptor: {
      id: 'antigravity-local',
      kind: 'antigravity',
      displayName: 'Antigravity Local',
      worktreeAssignment: false,
      progressReporting: false,
      cancellationIntent: false
    },
    status: async () => ({ availability: 'available' as const }),
    dispatch: async () => {
      antigravityCalls += 1;
      return { status: 'succeeded' as const, runId: 'anti-should-not-run' };
    }
  });

  const session = await fx.workSessions.create({
    name: 'no-cross-fallback-on-task-failure',
    workspace: 'projects',
    projectPath: 'repo'
  });

  await runWithWorkSession(session.id, async () => {
    const objective = await fx.taskGraphs.create({
      name: 'Real failure objective',
      objective: 'Do not hide a real implementation failure'
    });
    const task = await fx.taskGraphs.addTask(objective.id, {
      title: 'Compile implementation',
      concurrency: { operation: 'project.inspect' },
      execution: workerBinding('codex-local')
    });

    const output = await fx.taskWorkflowExecution.execute(objective.id, task.id);
    assert.equal(output.task.status, 'succeeded');
    assert.equal(antigravityCalls, 1);
    const attempts = await fx.taskAttempts.list({ taskId: task.id });
    assert.deepEqual(
      attempts[0]?.providerAttempts?.map(item => [item.providerId, item.status]),
      [['codex-local', 'failed'], ['antigravity-local', 'succeeded']]
    );
  });
});

test('ordinary AI failure does not cross-fallback when the assigned worktree became dirty', async t => {
  let antigravityCalls = 0;
  const executionPolicy = {
    async settings() {
      return { execution: { codexEnabled: true, antigravityEnabled: true, targetMode: 'all-three', codexFallback: 'rwmcp-only' } };
    },
    async status() { return { effectiveMode: 'both', fallbackActive: false }; },
    async beforeCodexDispatch() { return {}; },
    async activateSessionFallback() { return {}; }
  };
  const fx = await fixture(t, async () => {
    throw new Error('engineering workflow path should not run');
  }, {
    executionPolicy,
    worktreeStatus: async sessionId => ({
      sessionId,
      workspace: 'projects',
      repoPath: 'repo',
      worktreePath: 'repo.rwmcp-dirty',
      branch: 'rwmcp/session/dirty',
      commit: 'cccccccccccccccccccccccccccccccccccccccc',
      buildDir: 'repo.rwmcp-dirty/build',
      dirty: true
    })
  });
  fx.workerProviders.register({
    descriptor: { id: 'codex-local', kind: 'codex', displayName: 'Codex Local', worktreeAssignment: true, progressReporting: false, cancellationIntent: false },
    status: async () => ({ availability: 'available' as const }),
    dispatch: async () => ({ status: 'failed' as const, runId: 'codex-dirty-fail', summary: 'implementation failed after editing files' })
  });
  fx.workerProviders.register({
    descriptor: { id: 'antigravity-local', kind: 'antigravity', displayName: 'Antigravity Local', worktreeAssignment: true, progressReporting: false, cancellationIntent: false },
    status: async () => ({ availability: 'available' as const }),
    dispatch: async () => { antigravityCalls += 1; return { status: 'succeeded' as const, runId: 'anti-must-not-run' }; }
  });
  const session = await fx.workSessions.create({ name: 'dirty-fallback-session', workspace: 'projects', projectPath: 'repo' });
  await fx.workSessions.updateProject(session.id, {
    repoPath: 'repo',
    worktreePath: 'repo.rwmcp-dirty',
    buildDir: 'repo.rwmcp-dirty/build',
    branch: 'rwmcp/session/dirty',
    commit: 'cccccccccccccccccccccccccccccccccccccccc'
  });
  await runWithWorkSession(session.id, async () => {
    const objective = await fx.taskGraphs.create({ name: 'Dirty worktree fallback guard', objective: 'Do not transfer dirty ownership between AI workers' });
    const task = await fx.taskGraphs.addTask(objective.id, {
      title: 'Implementation with partial edits',
      concurrency: { operation: 'source.edit', key: 'repo.rwmcp-dirty' },
      execution: workerBinding('codex-local')
    });
    await assert.rejects(fx.taskWorkflowExecution.execute(objective.id, task.id), /implementation failed after editing files/);
    assert.equal(antigravityCalls, 0);
    const attempts = await fx.taskAttempts.list({ taskId: task.id });
    assert.deepEqual(attempts[0]?.providerAttempts?.map(item => [item.providerId, item.status]), [['codex-local', 'failed']]);
  });
});

test('Antigravity capacity failure falls through to Codex for frontend-preferred work and records the provider trace', async t => {
  const events: string[] = [];
  const executionPolicy = {
    async settings() {
      return { execution: { codexEnabled: true, antigravityEnabled: true, codexFallback: 'rwmcp-only' } };
    },
    async status() {
      return { effectiveMode: 'both', fallbackActive: false };
    },
    async beforeCodexDispatch(sessionId: string, options?: { deferFallback?: boolean }) {
      events.push(`before:${sessionId}:${options?.deferFallback === true}`);
      return {};
    },
    async activateSessionFallback() {
      throw new Error('RWMCP fallback should not activate when Codex succeeds');
    }
  };
  const fx = await fixture(t, async () => {
    throw new Error('engineering workflow path should not run');
  }, { executionPolicy });

  fx.workerProviders.register({
    descriptor: {
      id: 'antigravity-local',
      kind: 'antigravity',
      displayName: 'Antigravity Local',
      worktreeAssignment: false,
      progressReporting: false,
      cancellationIntent: false
    },
    status: async () => ({ availability: 'available' as const }),
    dispatch: async () => ({
      status: 'blocked' as const,
      runId: 'anti-limit-run',
      summary: 'ANTIGRAVITY_LIMIT_REACHED; resource exhausted'
    })
  });
  fx.workerProviders.register({
    descriptor: {
      id: 'codex-local',
      kind: 'codex',
      displayName: 'Codex Local',
      worktreeAssignment: false,
      progressReporting: false,
      cancellationIntent: false
    },
    status: async () => ({ availability: 'available' as const }),
    dispatch: async () => ({
      status: 'succeeded' as const,
      runId: 'codex-success-run',
      summary: 'implemented with alternate worker'
    })
  });

  const session = await fx.workSessions.create({
    name: 'reverse-symmetric-fallback-session',
    workspace: 'projects',
    projectPath: 'repo'
  });

  await runWithWorkSession(session.id, async () => {
    const objective = await fx.taskGraphs.create({
      name: 'Reverse symmetric worker objective',
      objective: 'Use Codex only after Antigravity capacity failure'
    });
    const task = await fx.taskGraphs.addTask(objective.id, {
      title: 'Frontend implementation',
      concurrency: { operation: 'project.inspect' },
      execution: workerBinding('antigravity-local')
    });

    const output = await fx.taskWorkflowExecution.execute(objective.id, task.id);
    assert.equal(output.task.status, 'succeeded');
    assert.deepEqual(events, [`before:${session.id}:true`]);

    const attempts = await fx.taskAttempts.list({ taskId: task.id });
    assert.equal(attempts[0]?.providerId, 'codex-local');
    assert.deepEqual(
      attempts[0]?.providerAttempts?.map(item => [item.providerId, item.status]),
      [['antigravity-local', 'blocked'], ['codex-local', 'succeeded']]
    );
  });
});
