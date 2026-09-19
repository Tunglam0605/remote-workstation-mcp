import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WorkSessionStore } from '../src/work-session.js';
import {
  currentWorkSessionId,
  resolveResourceOwner,
  runWithWorkSession
} from '../src/security/execution-context.js';

test('WorkSessionStore persists compact owner-scoped context and never discloses another principal session', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-work-session-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'work-sessions.json');
  let principal = 'openai-tunnel';

  const store = new WorkSessionStore(() => principal, {
    file,
    now: () => new Date('2026-09-19T07:00:00.000Z')
  });
  const session = await store.create({
    name: 'B300',
    workspace: 'stm32',
    projectPath: 'B300-Main-Custom',
    objective: 'Inspect and harden build workflow'
  });

  assert.equal(session.principalId, 'openai-tunnel');
  assert.equal(session.status, 'active');
  assert.equal(session.capsule.project?.workspace, 'stm32');
  assert.equal(session.capsule.project?.projectPath, 'B300-Main-Custom');
  assert.equal(session.capsule.currentObjective, 'Inspect and harden build workflow');
  assert.deepEqual(session.capsule.validatedFacts, []);

  const resumed = await store.resume(session.id);
  assert.deepEqual(resumed, session);
  const afterReconnect = new WorkSessionStore(() => principal, { file });
  assert.deepEqual(await afterReconnect.resume(session.id), session);
  assert.equal((await store.list()).length, 1);

  principal = 'different-principal';
  assert.deepEqual(await store.list(), []);
  await assert.rejects(store.resume(session.id), /Unknown active Work Session/);

  principal = 'openai-tunnel';
  const [second, third] = await Promise.all([
    store.create({ name: 'Callbox' }),
    store.create({ name: 'Vision' })
  ]);
  assert.notEqual(second.id, third.id);
  assert.equal((await store.list()).length, 3);
});

test('execution context produces distinct ResourceOwner keys for the same principal across Work Sessions', () => {
  const principal = 'openai-tunnel';
  const implicit = resolveResourceOwner(principal);
  assert.equal(implicit.workSessionId, 'implicit');
  assert.equal(implicit.implicit, true);

  const sessionA = '11111111-1111-4111-8111-111111111111';
  const sessionB = '22222222-2222-4222-8222-222222222222';

  const ownerA = runWithWorkSession(sessionA, () => {
    assert.equal(currentWorkSessionId(), sessionA);
    return resolveResourceOwner(principal);
  });
  const ownerB = runWithWorkSession(sessionB, () => resolveResourceOwner(principal));

  assert.equal(ownerA.principalId, ownerB.principalId);
  assert.notEqual(ownerA.key, ownerB.key);
  assert.equal(ownerA.implicit, false);
  assert.equal(ownerB.implicit, false);
  assert.equal(currentWorkSessionId(), 'implicit');
});


test('Context Capsule checkpoint stays bounded and replaces only explicit checkpoint fields', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-work-session-checkpoint-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const store = new WorkSessionStore('openai-tunnel', {
    file: path.join(root, 'work-sessions.json')
  });
  const session = await store.create({
    workspace: 'stm32',
    projectPath: 'B300-Main-Custom',
    objective: 'initial'
  });

  const updated = await store.checkpoint(session.id, {
    currentObjective: 'Validate multi-session isolation',
    validatedFacts: ['Phase 0 closed', 'Windows PTY acceptance passed'],
    selectedProvider: 'keil',
    selectedToolchain: 'ArmClang',
    selectedVariant: 'f407',
    lastAcceptance: 'v0.14.6 three-node acceptance passed',
    blockers: ['Windows integration pending'],
    decisions: ['Work Session id is not an authorization credential'],
    pendingActions: ['Run Windows CI']
  });

  assert.equal(updated.capsule.project?.workspace, 'stm32');
  assert.equal(updated.capsule.currentObjective, 'Validate multi-session isolation');
  assert.deepEqual(updated.capsule.validatedFacts, ['Phase 0 closed', 'Windows PTY acceptance passed']);
  assert.equal(updated.capsule.selectedProvider, 'keil');
  assert.equal(updated.capsule.selectedToolchain, 'ArmClang');
  assert.equal(updated.capsule.selectedVariant, 'f407');
  assert.deepEqual(updated.capsule.pendingActions, ['Run Windows CI']);

  await assert.rejects(
    store.checkpoint(session.id, { validatedFacts: Array.from({ length: 33 }, (_, i) => `fact-${i}`) }),
    /at most 32 items/
  );
  await assert.rejects(
    store.checkpoint(session.id, { decisions: ['x'.repeat(513)] }),
    /at most 512 characters/
  );
});
