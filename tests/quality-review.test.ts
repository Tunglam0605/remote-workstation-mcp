import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { QualityObservationStore } from '../src/quality-learning.js';
import { OwnerQualityReviewStore } from '../src/quality-review.js';
import { runWithWorkSession } from '../src/security/execution-context.js';
import { WorkflowRunStore } from '../src/workflow-run-store.js';

const sessionA = '33333333-3333-4333-8333-333333333333';

async function eligibleObservation(root: string) {
  const runs = new WorkflowRunStore('openai-tunnel', { file: path.join(root, 'runs.json') });
  const observations = new QualityObservationStore('openai-tunnel', {
    file: path.join(root, 'quality.json')
  });
  const run = await runWithWorkSession(sessionA, async () => {
    const started = await runs.begin('projects', 'repo', 'firmware.build');
    return runs.finish(started.id, 'succeeded');
  });
  const observation = await runWithWorkSession(sessionA, () =>
    observations.observe(run, { completionSource: 'workflow-output', explicitOutcome: true })
  );
  return { observations, observation };
}

test('owner-local review records approval without promotion or activation', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-owner-review-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));

  const { observations, observation } = await eligibleObservation(root);
  const reviews = new OwnerQualityReviewStore({ file: path.join(root, 'decisions.json') });

  const localCandidates = await observations.listForOwnerReview();
  assert.equal(localCandidates.length, 1);
  assert.equal(localCandidates[0]!.id, observation.id);

  const approved = await reviews.decide(observation, 'approved', 'Validated typed workflow evidence.');
  assert.equal(approved.decision, 'approved');
  assert.match(approved.observationDigest, /^[a-f0-9]{64}$/);

  const idempotent = await reviews.decide(observation, 'approved', 'Ignored duplicate reason.');
  assert.equal(idempotent.id, approved.id);

  const persistedObservation = await observations.getForOwnerReview(observation.id);
  assert.equal(persistedObservation?.promotionState, 'not-promoted');
  assert.equal(persistedObservation?.active, false);
});

test('owner can revoke only a prior approval and audit history remains append-only', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-owner-revoke-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));

  const { observation } = await eligibleObservation(root);
  const reviews = new OwnerQualityReviewStore({ file: path.join(root, 'decisions.json') });

  await assert.rejects(
    () => reviews.decide(observation, 'revoked'),
    /previously approved/
  );

  const approved = await reviews.decide(observation, 'approved');
  const revoked = await reviews.decide(observation, 'revoked', 'Owner withdrew approval.');

  assert.notEqual(revoked.id, approved.id);
  assert.equal(revoked.decision, 'revoked');

  const history = await reviews.list();
  assert.deepEqual(history.map(item => item.decision), ['revoked', 'approved']);
  assert.equal((await reviews.latest(observation.id))?.decision, 'revoked');
});

test('ineligible observations cannot receive owner approval', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-owner-ineligible-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));

  const runs = new WorkflowRunStore('openai-tunnel', { file: path.join(root, 'runs.json') });
  const observations = new QualityObservationStore('openai-tunnel', {
    file: path.join(root, 'quality.json')
  });
  const started = await runs.begin('projects', 'repo', 'firmware.build');
  const finished = await runs.finish(started.id, 'succeeded');
  const implicit = await observations.observe(finished, {
    completionSource: 'workflow-output',
    explicitOutcome: true
  });

  assert.equal(implicit.candidateState, 'ineligible');
  const reviews = new OwnerQualityReviewStore({ file: path.join(root, 'decisions.json') });
  await assert.rejects(
    () => reviews.decide(implicit, 'approved'),
    /pending-owner-review/
  );
});
