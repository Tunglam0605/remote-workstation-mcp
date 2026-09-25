import assert from 'node:assert/strict';
import test from 'node:test';
import { ObjectiveWaveExecutionService } from '../src/objective-wave-execution.js';
import type { SchedulerAwareTask } from '../src/scheduler-awareness.js';
import type { WorkObjective, WorkTask } from '../src/task-graph.js';

function task(id: string, title: string, execution: WorkTask['execution'], operation: WorkTask['concurrency']['operation'], key?: string): WorkTask {
  return {
    version: 1,
    id,
    objectiveId: 'objective-1',
    sequence: Number(id.replace(/\D/g, '')) || 1,
    generation: 1,
    title,
    priority: 0,
    status: 'ready',
    dependencies: [],
    concurrency: { ...(operation ? { operation } : {}), ...(key ? { key } : {}) },
    ...(execution ? { execution } : {}),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  };
}

function aware(value: WorkTask, className: SchedulerAwareTask['concurrencyDecision'] extends infer T ? any : never): SchedulerAwareTask {
  return {
    task: value,
    dispatchable: true,
    requiresLeaseCheck: className !== 'shared',
    concurrencyDecision: { operation: value.concurrency.operation!, class: className, keyRequired: className !== 'shared', reason: 'test' },
    availability: 'ready'
  };
}

function objective(tasks: WorkTask[]): WorkObjective {
  return {
    version: 1, id: 'objective-1', principalId: 'openai-tunnel', workSessionId: 'session-1',
    name: 'Wave', objective: 'Execute one bounded wave', status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', tasks
  };
}

test('wave execution serializes a worker-provider task even when other READY tasks exist', async () => {
  const worker = task('task-1', 'Frontend', { kind: 'worker-provider', providerId: 'antigravity-local' }, 'source.edit', 'wt');
  const backend = task('task-2', 'Backend', { kind: 'worker-provider', providerId: 'codex-local' }, 'source.edit', 'wt');
  const inspect = task('task-3', 'Inspect', { kind: 'engineering-workflow', workspace: 'projects', projectPath: '.', workflow: 'project.inspect', parameters: {} }, 'project.inspect');
  const state = objective([worker, backend, inspect]);
  const executed: string[] = [];
  const service = new ObjectiveWaveExecutionService(
    { snapshot: async () => ({ plan: [aware(worker, 'session-isolated'), aware(backend, 'session-isolated'), aware(inspect, 'shared')], sessions: [], recentAttempts: [], resources: [], serialSessions: [], debugSessions: [], nodeInterlocks: [], workerProviders: [] }) },
    { execute: async (_objectiveId, taskId) => { executed.push(taskId); state.tasks.find(item => item.id === taskId)!.status = 'succeeded'; } },
    { get: async () => structuredClone(state) }
  );
  const result = await service.executeWave(state.id, { maxParallel: 4 });
  assert.deepEqual(executed, ['task-1']);
  assert.equal(result.serializedWorkerTask, true);
  assert.deepEqual(result.selectedTaskIds, ['task-1']);
  assert.equal(result.results[0]?.status, 'succeeded');
  assert.equal(result.remainingReady, 2);
});

test('wave execution runs compatible deterministic tasks in parallel but excludes same concurrency identity', async () => {
  const a = task('task-1', 'Read', { kind: 'engineering-workflow', workspace: 'projects', projectPath: '.', workflow: 'project.inspect', parameters: {} }, 'project.inspect');
  const b = task('task-2', 'Build A', { kind: 'engineering-workflow', workspace: 'projects', projectPath: '.', workflow: 'project.verify', parameters: {} }, 'build.isolated', 'build-a');
  const c = task('task-3', 'Build A duplicate', { kind: 'engineering-workflow', workspace: 'projects', projectPath: '.', workflow: 'project.verify', parameters: {} }, 'build.isolated', 'build-a');
  const d = task('task-4', 'Build B', { kind: 'engineering-workflow', workspace: 'projects', projectPath: '.', workflow: 'project.verify', parameters: {} }, 'build.isolated', 'build-b');
  const state = objective([a, b, c, d]);
  const active = new Set<string>();
  let maxActive = 0;
  const service = new ObjectiveWaveExecutionService(
    { snapshot: async () => ({ plan: [aware(a, 'shared'), aware(b, 'session-isolated'), aware(c, 'session-isolated'), aware(d, 'session-isolated')], sessions: [], recentAttempts: [], resources: [], serialSessions: [], debugSessions: [], nodeInterlocks: [], workerProviders: [] }) },
    { execute: async (_objectiveId, taskId) => { active.add(taskId); maxActive = Math.max(maxActive, active.size); await new Promise(resolve => setTimeout(resolve, 10)); state.tasks.find(item => item.id === taskId)!.status = 'succeeded'; active.delete(taskId); } },
    { get: async () => structuredClone(state) }
  );
  const result = await service.executeWave(state.id, { maxParallel: 3 });
  assert.deepEqual(result.selectedTaskIds, ['task-1', 'task-2', 'task-4']);
  assert.equal(maxActive, 3);
  assert.equal(result.serializedWorkerTask, false);
  assert.equal(state.tasks.find(item => item.id === 'task-3')?.status, 'ready');
});

test('wave execution is a no-op when scheduler awareness has no READY task', async () => {
  const state = objective([]);
  const service = new ObjectiveWaveExecutionService(
    { snapshot: async () => ({ plan: [], sessions: [], recentAttempts: [], resources: [], serialSessions: [], debugSessions: [], nodeInterlocks: [], workerProviders: [] }) },
    { execute: async () => { throw new Error('must not execute'); } },
    { get: async () => structuredClone(state) }
  );
  const result = await service.executeWave(state.id);
  assert.deepEqual(result.selectedTaskIds, []);
  assert.match(result.note, /No scheduler-ready task/);
});
