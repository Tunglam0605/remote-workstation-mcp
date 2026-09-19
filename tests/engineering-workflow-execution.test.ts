import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { EngineeringWorkflowEngine } from '../src/adapters/engineering/workflow-engine.js';
import { EngineeringWorkflowExecutionService } from '../src/engineering-workflow-execution.js';
import { NodeInterlockStore } from '../src/node-interlock.js';
import { QualityObservationStore } from '../src/quality-learning.js';
import { runWithWorkSession } from '../src/security/execution-context.js';
import { WorkflowRunStore } from '../src/workflow-run-store.js';

const SESSION = '44444444-4444-4444-8444-444444444444';

async function fixture(
  t: test.TestContext,
  run: (...args: unknown[]) => Promise<unknown>
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-workflow-execution-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));

  let tick = 0;
  const now = () => new Date(1_820_000_000_000 + tick++ * 1000);
  const workflowRuns = new WorkflowRunStore('openai-tunnel', {
    file: path.join(root, 'workflow-runs.json'),
    now
  });
  const quality = new QualityObservationStore('openai-tunnel', {
    file: path.join(root, 'quality-observations.json'),
    settingsFile: path.join(root, 'quality-settings.json'),
    now
  });
  const interlocks = new NodeInterlockStore('openai-tunnel', {
    file: path.join(root, 'interlocks.json'),
    now,
    pid: 4545,
    pidAlive: () => true
  });
  const engine = { run } as unknown as EngineeringWorkflowEngine;
  const service = new EngineeringWorkflowExecutionService(
    engine,
    workflowRuns,
    quality,
    interlocks
  );
  return { service, workflowRuns, quality, interlocks };
}

test('shared workflow execution service records successful run, quality evidence and releases interlock', async t => {
  const { service, workflowRuns, quality, interlocks } = await fixture(t, async () => ({
    workflow: 'firmware.build',
    status: 'succeeded',
    plan: { steps: [] },
    steps: []
  }));

  const output = await runWithWorkSession(SESSION, () =>
    service.run('projects', 'firmware/demo', 'firmware.build', { variant: 'debug' })
  );
  const workflowRun = output.workflowRun as { status?: string };
  assert.equal(workflowRun.status, 'succeeded');

  const runs = await runWithWorkSession(SESSION, () => workflowRuns.list());
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.status, 'succeeded');
  assert.equal(runs[0]?.workSessionId, SESSION);

  const observations = await runWithWorkSession(SESSION, () => quality.list());
  assert.equal(observations.length, 1);
  assert.equal(observations[0]?.candidateState, 'pending-owner-review');
  assert.equal(observations[0]?.completionSource, 'workflow-output');
  assert.deepEqual(await interlocks.listActive(), []);
});

test('shared workflow execution service preserves blocked workflow outcome as ineligible evidence', async t => {
  const { service, workflowRuns, quality, interlocks } = await fixture(t, async () => ({
    workflow: 'stm32.deploy_accept',
    status: 'blocked',
    plan: { blockers: ['probe unavailable'] },
    steps: []
  }));

  const output = await runWithWorkSession(SESSION, () =>
    service.run('projects', 'firmware/demo', 'stm32.deploy_accept', {})
  );
  assert.equal((output.workflowRun as { status?: string }).status, 'blocked');

  const runs = await runWithWorkSession(SESSION, () => workflowRuns.list());
  assert.equal(runs[0]?.status, 'blocked');
  const observations = await runWithWorkSession(SESSION, () => quality.list());
  assert.equal(observations[0]?.candidateState, 'ineligible');
  assert.equal(observations[0]?.outcome, 'blocked');
  assert.deepEqual(await interlocks.listActive(), []);
});

test('shared workflow execution service records exceptions as failed and always releases interlock', async t => {
  const { service, workflowRuns, quality, interlocks } = await fixture(t, async () => {
    throw new Error('provider exploded');
  });

  await assert.rejects(
    runWithWorkSession(SESSION, () =>
      service.run('projects', 'firmware/demo', 'firmware.build', {})
    ),
    /provider exploded/
  );

  const runs = await runWithWorkSession(SESSION, () => workflowRuns.list());
  assert.equal(runs[0]?.status, 'failed');
  assert.equal(runs[0]?.error, 'provider exploded');

  const observations = await runWithWorkSession(SESSION, () => quality.list());
  assert.equal(observations[0]?.completionSource, 'exception');
  assert.equal(observations[0]?.candidateState, 'ineligible');
  assert.deepEqual(await interlocks.listActive(), []);
});
