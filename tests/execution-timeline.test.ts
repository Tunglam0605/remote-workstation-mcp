import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ExecutionTimelineService } from '../src/execution-timeline.js';
import { runWithWorkSession } from '../src/security/execution-context.js';
import { TaskAttemptStore } from '../src/task-attempt-store.js';
import { TaskGraphStore } from '../src/task-graph.js';

const SESSION = '45454545-4545-4454-8454-454545454545';

test('Execution timeline derives provider stages, fallback and cancellation without invented percentage progress', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-execution-timeline-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  let tick = 0;
  const now = () => new Date(1_900_000_000_000 + tick++ * 1000);
  const graphs = new TaskGraphStore('openai-tunnel', { file: path.join(root, 'objectives.json'), now });
  const attempts = new TaskAttemptStore('openai-tunnel', { file: path.join(root, 'attempts.json'), now });
  const timeline = new ExecutionTimelineService(graphs, attempts, now);

  await runWithWorkSession(SESSION, async () => {
    const objective = await graphs.create({ name: 'Agent timeline', objective: 'Show real execution evidence' });
    const task = await graphs.addTask(objective.id, {
      title: 'Frontend polish',
      concurrency: { operation: 'source.edit', key: 'ui' },
      execution: { kind: 'worker-provider', providerId: 'antigravity-local' }
    });
    await graphs.startTask(objective.id, task.id);
    const attempt = (await attempts.begin(objective.id, task.id, 1, { providerId: 'antigravity-local' })).attempt;
    await attempts.updateRunning(attempt.id, {
      providerId: 'codex-local',
      providerAttempts: [{ providerId: 'antigravity-local', status: 'failed', summary: 'safe clean fallback' }]
    });
    await attempts.requestCancellation(objective.id, task.id, 1);

    const active = await timeline.timeline(objective.id);
    assert.equal(active.active.length, 1);
    assert.equal(active.active[0]?.plannedTarget, 'antigravity-local');
    assert.equal(active.active[0]?.selectedTarget, 'codex-local');
    assert.equal(active.active[0]?.fallbackUsed, true);
    assert.equal(active.active[0]?.cancellationRequested, true);
    assert.ok(active.active[0]?.steps.some(step => step.kind === 'provider-finished' && step.providerId === 'antigravity-local'));
    assert.ok(active.active[0]?.steps.some(step => step.kind === 'provider-running' && step.providerId === 'codex-local'));
    assert.ok(active.active[0]?.steps.some(step => step.kind === 'cancellation-requested'));
    assert.equal(active.semantics.progressModel, 'stage-only');
    assert.equal('percent' in active.active[0]!, false);

    await graphs.finishTask(objective.id, task.id, 'cancelled', 'cancelled-by-request');
    await attempts.finish(attempt.id, 'cancelled', {
      providerId: 'codex-local',
      providerAttempts: [
        { providerId: 'antigravity-local', status: 'failed', summary: 'safe clean fallback' },
        { providerId: 'codex-local', status: 'cancelled', summary: 'cancelled-by-request' }
      ]
    });
    const finished = await timeline.timeline(objective.id, { taskId: task.id });
    assert.equal(finished.active.length, 0);
    assert.equal(finished.history[0]?.attemptStatus, 'cancelled');
    assert.ok(finished.history[0]?.steps.some(step => step.kind === 'attempt-finished' && step.status === 'cancelled'));
  });
});

test('Execution timeline marks explicit RWMCP direct handoff from provider evidence', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-execution-timeline-rwmcp-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const graphs = new TaskGraphStore('openai-tunnel', { file: path.join(root, 'objectives.json') });
  const attempts = new TaskAttemptStore('openai-tunnel', { file: path.join(root, 'attempts.json') });
  const timeline = new ExecutionTimelineService(graphs, attempts);
  await runWithWorkSession(SESSION, async () => {
    const objective = await graphs.create({ name: 'Fallback', objective: 'Show RWMCP handoff' });
    const task = await graphs.addTask(objective.id, {
      title: 'Backend edit', concurrency: { operation: 'source.edit', key: 'backend' },
      execution: { kind: 'worker-provider', providerId: 'codex-local' }
    });
    await graphs.startTask(objective.id, task.id);
    const attempt = (await attempts.begin(objective.id, task.id, 1, { providerId: 'codex-local' })).attempt;
    await attempts.finish(attempt.id, 'blocked', {
      providerId: 'rwmcp-direct',
      providerAttempts: [
        { providerId: 'codex-local', status: 'blocked', summary: 'quota' },
        { providerId: 'antigravity-local', status: 'failed', summary: 'unavailable' },
        { providerId: 'rwmcp-direct', status: 'blocked', summary: 'direct handoff required' }
      ]
    });
    await graphs.finishTask(objective.id, task.id, 'failed', 'handoff-required');
    const view = await timeline.timeline(objective.id);
    assert.equal(view.history[0]?.directRwmcpHandoff, true);
    assert.equal(view.history[0]?.fallbackUsed, true);
    assert.equal(view.history[0]?.selectedTarget, 'rwmcp-direct');
  });
});
