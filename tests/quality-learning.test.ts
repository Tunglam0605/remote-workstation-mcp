import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { QualityObservationStore } from '../src/quality-learning.js';
import { runWithWorkSession } from '../src/security/execution-context.js';
import { WorkflowRunStore } from '../src/workflow-run-store.js';

const sessionA = '11111111-1111-4111-8111-111111111111';
const sessionB = '22222222-2222-4222-8222-222222222222';

test('explicit successful typed workflow becomes pending owner review without auto activation', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-quality-success-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));

  const runs = new WorkflowRunStore('openai-tunnel', { file: path.join(root, 'runs.json') });
  const observations = new QualityObservationStore('openai-tunnel', {
    file: path.join(root, 'quality.json')
  });

  const run = await runWithWorkSession(sessionA, async () => {
    const started = await runs.begin('projects', 'repo', 'firmware.build');
    return runs.finish(started.id, 'succeeded');
  });

  const observation = await runWithWorkSession(sessionA, () =>
    observations.observe(run, {
      completionSource: 'workflow-output',
      explicitOutcome: true
    })
  );

  assert.equal(observation.candidateState, 'pending-owner-review');
  assert.equal(observation.promotionState, 'not-promoted');
  assert.equal(observation.active, false);
  assert.equal(observation.qualityGate.passed, true);
  assert.deepEqual(observation.antiPatterns, []);
  assert.match(observation.environment.hash, /^[a-f0-9]{64}$/);
  assert.equal(observation.environment.platform, process.platform);
  assert.equal(observation.environment.arch, process.arch);

  const listedA = await runWithWorkSession(sessionA, () => observations.list());
  assert.equal(listedA.length, 1);
  await runWithWorkSession(sessionB, async () => {
    assert.deepEqual(await observations.list(), []);
  });
});

test('repetition is not quality: implicit or ambiguous success is ineligible', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-quality-ineligible-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));

  const runs = new WorkflowRunStore('openai-tunnel', { file: path.join(root, 'runs.json') });
  const observations = new QualityObservationStore('openai-tunnel', {
    file: path.join(root, 'quality.json')
  });

  const implicitStarted = await runs.begin('projects', 'repo', 'firmware.build');
  const implicitFinished = await runs.finish(implicitStarted.id, 'succeeded');
  const implicitObservation = await observations.observe(implicitFinished, {
    completionSource: 'workflow-output',
    explicitOutcome: true
  });
  assert.equal(implicitObservation.candidateState, 'ineligible');
  assert.ok(implicitObservation.antiPatterns.includes('implicit-work-session'));

  const ambiguousFinished = await runWithWorkSession(sessionA, async () => {
    const started = await runs.begin('projects', 'repo', 'firmware.build');
    return runs.finish(started.id, 'succeeded');
  });
  const ambiguousObservation = await runWithWorkSession(sessionA, () =>
    observations.observe(ambiguousFinished, {
      completionSource: 'workflow-output',
      explicitOutcome: false
    })
  );
  assert.equal(ambiguousObservation.candidateState, 'ineligible');
  assert.ok(ambiguousObservation.antiPatterns.includes('ambiguous-outcome-evidence'));
});

test('failed, exception and restart-reconciled workflows never become learning candidates', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-quality-failures-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));

  const runFile = path.join(root, 'runs.json');
  const runs = new WorkflowRunStore('openai-tunnel', { file: runFile });
  const observations = new QualityObservationStore('openai-tunnel', {
    file: path.join(root, 'quality.json')
  });

  const failed = await runWithWorkSession(sessionA, async () => {
    const started = await runs.begin('projects', 'repo', 'firmware.flash');
    return runs.finish(started.id, 'failed', 'probe unavailable');
  });
  const failedObservation = await runWithWorkSession(sessionA, () =>
    observations.observe(failed, {
      completionSource: 'exception',
      explicitOutcome: true
    })
  );
  assert.equal(failedObservation.candidateState, 'ineligible');
  assert.ok(failedObservation.antiPatterns.includes('non-success-outcome'));
  assert.ok(failedObservation.antiPatterns.includes('exception-completion'));

  await runWithWorkSession(sessionA, () => runs.begin('projects', 'repo', 'firmware.verify'));
  const afterRestart = new WorkflowRunStore('openai-tunnel', { file: runFile });
  const reconciled = await afterRestart.reconcileInterruptedRecords();
  assert.equal(reconciled.length, 1);

  const restartObservation = await observations.observe(reconciled[0]!, {
    completionSource: 'runtime-reconciliation',
    explicitOutcome: true
  });
  assert.equal(restartObservation.candidateState, 'ineligible');
  assert.ok(restartObservation.antiPatterns.includes('runtime-reconciliation'));
  assert.equal(restartObservation.active, false);
});

test('one workflow run produces at most one quality observation', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-quality-idempotent-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));

  const runs = new WorkflowRunStore('openai-tunnel', { file: path.join(root, 'runs.json') });
  const observations = new QualityObservationStore('openai-tunnel', {
    file: path.join(root, 'quality.json')
  });

  const run = await runWithWorkSession(sessionA, async () => {
    const started = await runs.begin('projects', 'repo', 'firmware.build');
    return runs.finish(started.id, 'succeeded');
  });

  const first = await runWithWorkSession(sessionA, () =>
    observations.observe(run, { completionSource: 'workflow-output', explicitOutcome: true })
  );
  const second = await runWithWorkSession(sessionA, () =>
    observations.observe(run, { completionSource: 'workflow-output', explicitOutcome: true })
  );

  assert.equal(second.id, first.id);
  assert.equal((await runWithWorkSession(sessionA, () => observations.list())).length, 1);
});

test('malformed or semantically tampered observations are never canonical quality evidence', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-quality-malformed-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'quality.json');

  const runs = new WorkflowRunStore('openai-tunnel', { file: path.join(root, 'runs.json') });
  const observations = new QualityObservationStore('openai-tunnel', { file });
  const implicitStarted = await runs.begin('projects', 'repo', 'firmware.build');
  const implicitFinished = await runs.finish(implicitStarted.id, 'succeeded');
  const valid = await observations.observe(implicitFinished, {
    completionSource: 'workflow-output',
    explicitOutcome: true
  });
  assert.equal(valid.candidateState, 'ineligible');

  const persisted = JSON.parse(await fs.readFile(file, 'utf8')) as {
    observations: Array<{ candidateState: string; qualityGate: { passed: boolean } }>;
  };
  persisted.observations[0]!.candidateState = 'pending-owner-review';
  persisted.observations[0]!.qualityGate.passed = true;
  await fs.writeFile(file, JSON.stringify(persisted), 'utf8');

  const reloaded = new QualityObservationStore('openai-tunnel', { file });
  assert.deepEqual(await reloaded.list(), []);
});
