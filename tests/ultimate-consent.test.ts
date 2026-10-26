import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { UltimateConsentManager } from '../src/security/ultimate-consent.js';

const allowed = {
  nodeId: 'dev_windows',
  principalId: 'openai-tunnel',
  durationMinutes: 240 as const,
  scope: {
    operations: ['build', 'transfer'] as const,
    workspaces: ['stm32'],
    profileIds: ['keil-release'],
    transferGrantIds: ['ssd-to-windows'],
    workSessionId: 'session-a'
  }
};

async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-ultimate-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const epochPath = path.join(root, 'runtime-epoch.json');
  await fs.writeFile(epochPath, JSON.stringify({ epoch: 'epoch-A' }));
  const filePath = path.join(root, 'ultimate.json');
  let wallMs = Date.parse('2026-10-24T10:00:00.000Z');
  let uptimeMs = 100_000;
  const clock = { wallMs: () => wallMs, uptimeMs: () => uptimeMs };
  const manager = new UltimateConsentManager({
    filePath,
    epochPath,
    clock
  });
  const move = (elapsedMs: number, wallShiftMs = elapsedMs) => {
    uptimeMs += elapsedMs;
    wallMs += wallShiftMs;
  };
  return { manager, epochPath, filePath, clock, move };
}

test('Ultimate lease accepts only four bounded choices and never extends from repeated status reads', async t => {
  const { manager, move } = await fixture(t);
  for (const minutes of [30, 60, 120, 240] as const) {
    const started = await manager.activate({ ...allowed, durationMinutes: minutes });
    assert.equal(started.active, true);
    assert.equal(started.remainingSeconds, minutes * 60);
    move(1_000);
    const checked = await manager.status();
    assert.equal(checked.remainingSeconds, minutes * 60 - 1);
    await manager.revoke();
  }
  await assert.rejects(
    manager.activate({ ...allowed, durationMinutes: 241 as 240 }),
    /duration|minutes|TTL/i
  );
  await assert.rejects(
    manager.activate({ ...allowed, durationMinutes: 0 as 240 }),
    /duration|minutes|TTL/i
  );
});

test('Ultimate lease expires even when wall clock moves backward', async t => {
  const { manager, move } = await fixture(t);
  await manager.activate({ ...allowed, durationMinutes: 30 });
  move(29 * 60_000, -60_000);
  assert.equal((await manager.status()).active, true);
  move(60_000, -3_600_000);
  assert.equal((await manager.status()).active, false);
  await assert.rejects(
    manager.assertAllowed({
      nodeId: allowed.nodeId, principalId: allowed.principalId,
      operation: 'build', workspaceId: 'stm32', profileId: 'keil-release', workSessionId: 'session-a'
    }), /expired|inactive|denied/i
  );
});

test('Ultimate lease is exact to principal, node, workspace, profile, grant and Work Session', async t => {
  const { manager } = await fixture(t);
  await manager.activate(allowed);
  const action = {
    nodeId: allowed.nodeId, principalId: allowed.principalId,
    operation: 'build' as const, workspaceId: 'stm32', profileId: 'keil-release', workSessionId: 'session-a'
  };
  await manager.assertAllowed(action);
  for (const altered of [
    { principalId: 'different-tunnel' }, { nodeId: 'dev_other' },
    { operation: 'test' as const }, { workspaceId: 'projects' },
    { profileId: 'arbitrary-command' }, { workSessionId: 'session-b' }
  ]) {
    await assert.rejects(manager.assertAllowed({ ...action, ...altered }), /denied|scope|not allowed/i);
  }
  await manager.assertAllowed({ ...action, operation: 'transfer', grantId: 'ssd-to-windows' });
  await assert.rejects(
    manager.assertAllowed({ ...action, operation: 'transfer', grantId: 'other-direction' }),
    /denied|scope|not allowed/i
  );
});

test('runtime epoch change, missing or malformed consent and explicit revoke fail closed', async t => {
  const { manager, epochPath, filePath } = await fixture(t);
  assert.equal((await manager.status()).active, false);
  await manager.activate(allowed);
  await fs.writeFile(epochPath, JSON.stringify({ epoch: 'epoch-B' }));
  assert.equal((await manager.status()).active, false);
  await assert.rejects(manager.assertAllowed({
    nodeId: 'dev_windows', principalId: 'openai-tunnel',
    operation: 'build', workspaceId: 'stm32', profileId: 'keil-release', workSessionId: 'session-a'
  }), /expired|inactive|denied/i);
  await fs.writeFile(filePath, '{broken-json');
  assert.equal((await manager.status()).active, false);
  await manager.revoke();
  assert.equal((await manager.status()).active, false);
  assert.equal((await manager.status()).state, 'revoked');
  const lifecycle = await manager.recentEvents();
  assert.deepEqual(lifecycle.map(item => item.action), ['activated', 'revoked']);
  assert.equal(JSON.stringify(lifecycle).includes('runtimeEpoch'), false);
});

test('Ultimate never accepts overlapping concurrent activation requests', async t => {
  const { manager, epochPath, filePath, clock } = await fixture(t);
  const otherManager = new UltimateConsentManager({ epochPath, filePath, clock });
  const outcomes = await Promise.allSettled([
    manager.activate(allowed),
    otherManager.activate({ ...allowed, durationMinutes: 30 })
  ]);
  assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(item => item.status === 'rejected').length, 1);
  assert.equal((await manager.status()).active, true);
});

test('Ultimate owner revoke and activation do not overlap across manager instances', async t => {
  const { manager, epochPath, filePath, clock } = await fixture(t);
  const otherManager = new UltimateConsentManager({ epochPath, filePath, clock });
  const results = await Promise.allSettled([
    manager.activate(allowed),
    otherManager.revoke()
  ]);
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(results.filter(item => item.status === 'rejected').length, 1);
  assert.equal((await manager.status()).active, true);
});
