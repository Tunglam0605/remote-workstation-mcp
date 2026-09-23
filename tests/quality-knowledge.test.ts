import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  QualityObservationStore,
  buildEnvironmentFingerprint,
  deriveQualityCompatibilityInput
} from '../src/quality-learning.js';
import { QualityLearningSettingsStore } from '../src/quality-learning-policy.js';
import {
  QualityKnowledgeStore,
  compareCanonicalBaseline
} from '../src/quality-knowledge.js';
import { OwnerQualityReviewStore } from '../src/quality-review.js';
import { runWithWorkSession } from '../src/security/execution-context.js';
import { WorkflowRunStore } from '../src/workflow-run-store.js';

const sessionA = '44444444-4444-4444-8444-444444444444';

async function createEvidence(root: string, count: number, approve: boolean) {
  let tick = Date.now();
  const runs = new WorkflowRunStore('openai-tunnel', {
    file: path.join(root, 'runs.json'),
    now: () => new Date(tick += 100)
  });
  const observations = new QualityObservationStore('openai-tunnel', {
    file: path.join(root, 'observations.json'),
    settingsFile: path.join(root, 'settings.json')
  });
  const reviews = new OwnerQualityReviewStore({ file: path.join(root, 'reviews.json') });
  const records = [];

  for (let index = 0; index < count; index += 1) {
    const observation = await runWithWorkSession(sessionA, async () => {
      const started = await runs.begin('projects', 'repo', 'firmware.build');
      const finished = await runs.finish(started.id, 'succeeded');
      return observations.observe(finished, {
        completionSource: 'workflow-output',
        explicitOutcome: true
      });
    });
    assert.ok(observation);
    records.push(observation);
    if (approve) await reviews.decide(observation, 'approved', 'Owner validated evidence.');
  }
  return records;
}

test('repetition without owner approval never becomes promotable knowledge', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-quality-noapproval-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  await createEvidence(root, 5, false);

  const knowledge = new QualityKnowledgeStore({
    file: path.join(root, 'knowledge.json'),
    observationFile: path.join(root, 'observations.json'),
    reviewFile: path.join(root, 'reviews.json'),
    settingsFile: path.join(root, 'settings.json')
  });
  const draft = await knowledge.createDraft('projects', 'repo', 'firmware.build');

  assert.equal(draft.metrics.totalSamples, 5);
  assert.equal(draft.metrics.approvedSamples, 0);
  assert.equal(draft.promotionGate.passed, false);
  assert.ok(draft.promotionGate.reasons.includes('insufficient-approved-samples'));

  const shadow = await knowledge.evaluateShadow(draft.id, buildEnvironmentFingerprint().hash);
  assert.equal(shadow.shadow.status, 'needs-more-evidence');
  await assert.rejects(() => knowledge.promote(shadow.id), /shadow-passed/);
});

test('approved typed evidence can pass shadow review and promote only to inactive recommendation knowledge', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-quality-promote-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  await createEvidence(root, 3, true);

  const knowledge = new QualityKnowledgeStore({
    file: path.join(root, 'knowledge.json'),
    observationFile: path.join(root, 'observations.json'),
    reviewFile: path.join(root, 'reviews.json'),
    settingsFile: path.join(root, 'settings.json')
  });
  const draft = await knowledge.createDraft('projects', 'repo', 'firmware.build');
  assert.equal(draft.promotionGate.passed, true);
  assert.equal(draft.baseline.status, 'matches-canonical');

  const shadow = await knowledge.evaluateShadowAgainstApprovedEvidence(draft.id);
  assert.equal(shadow.shadow.status, 'passed');

  const promoted = await knowledge.promote(shadow.id, 'Validated for recommendation reuse.');
  assert.equal(promoted.state, 'promoted');
  assert.equal(promoted.class, 'proven-learned');
  assert.equal(promoted.recommendationOnly, true);
  assert.equal(promoted.executionActive, false);
  assert.equal(promoted.knowledgeVersion, 1);
  assert.notEqual(promoted.id, shadow.id);
  assert.equal(promoted.supersedesId, shadow.id);

  const history = await knowledge.list(20);
  assert.equal(history.length, 3);
  assert.deepEqual(
    history.map(item => item.state),
    ['promoted', 'shadow', 'draft']
  );
});

test('environment fingerprint tracks project workflow variant provider toolchain and hashes hardware identity', () => {
  const compatibility = deriveQualityCompatibilityInput({
    workspace: 'projects',
    projectPath: 'repo',
    workflow: 'stm32.deploy-accept',
    runtimeParameters: {
      variant: 'F407',
      probeSerial: 'STLINK-SECRET-SERIAL'
    },
    output: {
      provider: 'openocd',
      providerVersion: '0.12.0',
      toolchain: {
        family: 'arm-none-eabi-gcc',
        version: '13.2'
      }
    }
  });
  const fingerprint = buildEnvironmentFingerprint(compatibility);

  assert.match(fingerprint.projectIdentityHash ?? '', /^[a-f0-9]{64}$/);
  assert.match(fingerprint.hardwareIdentityHash ?? '', /^[a-f0-9]{64}$/);
  assert.equal(fingerprint.workflow, 'stm32.deploy-accept');
  assert.equal(fingerprint.variant, 'F407');
  assert.equal(fingerprint.provider, 'openocd');
  assert.equal(fingerprint.providerVersion, '0.12.0');
  assert.equal(fingerprint.toolchain, 'arm-none-eabi-gcc');
  assert.equal(fingerprint.toolchainVersion, '13.2');
  assert.notEqual(fingerprint.hardwareIdentityHash, 'STLINK-SECRET-SERIAL');
  assert.equal('probeSerial' in fingerprint, false);

  const changedVariant = buildEnvironmentFingerprint({
    ...compatibility,
    variant: 'H743'
  });
  assert.notEqual(changedVariant.hash, fingerprint.hash);
});

test('canonical typed workflow beats raw-shell or manual repetition', () => {
  const raw = compareCanonicalBaseline({
    workflow: 'stm32.deploy-accept',
    executionKind: 'raw-shell',
    canonicalWorkflowAvailable: true
  });
  assert.equal(raw.status, 'prefer-canonical');
  assert.ok(raw.antiPatterns.includes('raw-shell-when-typed-workflow-exists'));

  const typed = compareCanonicalBaseline({
    workflow: 'stm32.deploy-accept',
    executionKind: 'typed-workflow',
    canonicalWorkflowAvailable: true
  });
  assert.equal(typed.status, 'matches-canonical');
  assert.deepEqual(typed.antiPatterns, []);
});

test('material environment change demotes recommendation to shadow revalidation without mutating promoted history', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-quality-revalidate-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  await createEvidence(root, 3, true);

  const knowledge = new QualityKnowledgeStore({
    file: path.join(root, 'knowledge.json'),
    observationFile: path.join(root, 'observations.json'),
    reviewFile: path.join(root, 'reviews.json'),
    settingsFile: path.join(root, 'settings.json')
  });
  const draft = await knowledge.createDraft('projects', 'repo', 'firmware.build');
  const shadow = await knowledge.evaluateShadowAgainstApprovedEvidence(draft.id);
  const promoted = await knowledge.promote(shadow.id);
  const changedEnvironment = 'a'.repeat(64);

  assert.ok(!promoted.environmentHashes.includes(changedEnvironment));
  const revalidated = await knowledge.revalidateEnvironment(promoted.id, changedEnvironment);
  assert.equal(revalidated.state, 'shadow');
  assert.equal(revalidated.shadow.status, 'needs-revalidation');
  assert.ok(revalidated.shadow.reasons.includes('material-environment-change'));
  assert.notEqual(revalidated.id, promoted.id);

  const history = await knowledge.list(20);
  const preserved = history.find(item => item.id === promoted.id);
  assert.equal(preserved?.state, 'promoted');
});

test('failed workflow history lowers quality and blocks promotion even when enough successes were approved', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-quality-failure-penalty-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  await createEvidence(root, 3, true);

  const runs = new WorkflowRunStore('openai-tunnel', { file: path.join(root, 'runs.json') });
  const observations = new QualityObservationStore('openai-tunnel', {
    file: path.join(root, 'observations.json'),
    settingsFile: path.join(root, 'settings.json')
  });
  for (let index = 0; index < 2; index += 1) {
    await runWithWorkSession(sessionA, async () => {
      const started = await runs.begin('projects', 'repo', 'firmware.build');
      const finished = await runs.finish(started.id, 'failed', 'simulated-failure');
      await observations.observe(finished, {
        completionSource: 'workflow-output',
        explicitOutcome: true
      });
    });
  }

  const knowledge = new QualityKnowledgeStore({
    file: path.join(root, 'knowledge.json'),
    observationFile: path.join(root, 'observations.json'),
    reviewFile: path.join(root, 'reviews.json'),
    settingsFile: path.join(root, 'settings.json')
  });
  const draft = await knowledge.createDraft('projects', 'repo', 'firmware.build');

  assert.equal(draft.metrics.totalSamples, 5);
  assert.equal(draft.metrics.approvedSamples, 3);
  assert.equal(draft.metrics.succeeded, 3);
  assert.equal(draft.metrics.failed, 2);
  assert.equal(draft.metrics.successRate, 0.6);
  assert.equal(draft.promotionGate.passed, false);
  assert.ok(draft.promotionGate.reasons.includes('success-rate-below-0.8'));
});

test('tampered reusable knowledge record is rejected instead of becoming trusted state', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-quality-tamper-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  await createEvidence(root, 3, true);

  const knowledgeFile = path.join(root, 'knowledge.json');
  const options = {
    file: knowledgeFile,
    observationFile: path.join(root, 'observations.json'),
    reviewFile: path.join(root, 'reviews.json'),
    settingsFile: path.join(root, 'settings.json')
  };
  const knowledge = new QualityKnowledgeStore(options);
  const draft = await knowledge.createDraft('projects', 'repo', 'firmware.build');
  const shadow = await knowledge.evaluateShadowAgainstApprovedEvidence(draft.id);
  const promoted = await knowledge.promote(shadow.id);

  const persisted = JSON.parse(await fs.readFile(knowledgeFile, 'utf8')) as {
    records: Array<{ id: string; executionActive: boolean }>;
  };
  const promotedOnDisk = persisted.records.find(item => item.id === promoted.id);
  assert.ok(promotedOnDisk);
  promotedOnDisk.executionActive = true;
  await fs.writeFile(knowledgeFile, `${JSON.stringify(persisted, null, 2)}\n`, 'utf8');

  const reloaded = new QualityKnowledgeStore(options);
  assert.equal(await reloaded.latest(promoted.id), undefined);
  assert.ok((await reloaded.list(20)).every(item => item.executionActive === false));
});

test('owner can disable collection and clear learned history without touching canonical project data', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-quality-disable-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const settingsFile = path.join(root, 'settings.json');
  const settings = new QualityLearningSettingsStore({ file: settingsFile });
  await settings.update({ enabled: false });

  const runs = new WorkflowRunStore('openai-tunnel', { file: path.join(root, 'runs.json') });
  const observations = new QualityObservationStore('openai-tunnel', {
    file: path.join(root, 'observations.json'),
    settingsFile
  });
  const result = await runWithWorkSession(sessionA, async () => {
    const started = await runs.begin('projects', 'repo', 'firmware.build');
    const finished = await runs.finish(started.id, 'succeeded');
    return observations.observe(finished, {
      completionSource: 'workflow-output',
      explicitOutcome: true
    });
  });
  assert.equal(result, undefined);
  assert.deepEqual(await observations.listForOwnerLearning(), []);

  const canonicalFile = path.join(root, 'project.yaml');
  await fs.writeFile(canonicalFile, 'version: 1\nid: canonical-project\n', 'utf8');
  await settings.update({ enabled: true });
  await createEvidence(root, 1, false);
  assert.equal(await observations.clearForOwnerLearning(), 1);
  assert.equal(await fs.readFile(canonicalFile, 'utf8'), 'version: 1\nid: canonical-project\n');
});
