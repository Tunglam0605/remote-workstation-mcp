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
