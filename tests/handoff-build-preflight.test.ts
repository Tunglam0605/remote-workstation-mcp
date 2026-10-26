import assert from 'node:assert/strict';
import test from 'node:test';
import { validateHandoffBuildIntent } from '../src/adapters/engineering/handoff-build-preflight.js';
const manifest = {
  schemaVersion: 1 as const, jobId: 'job-1', sourceNodeId: 'ssd', destinationNodeId: 'windows',
  sourceWorkspace: 'sources', destinationWorkspace: 'builds', projectId: 'stm32-project',
  sourceRevision: 'commit-abcd', role: 'source' as const, toolchainProfileId: 'keil-release',
  createdAt: '2026-10-24T01:00:00Z', files: [{ relativePath: 'Core/main.c', bytes: 1, sha256: 'a'.repeat(64) }]
};
const intent = {
  manifest, localNodeId: 'windows', workspaceId: 'builds',
  requestedProfileId: 'keil-release', requestedTarget: 'STM32F407-Release',
  cleanSnapshot: true, buildHooks: [] as string[],
  sourceRevision: 'commit-abcd',
  ownerProfiles: [{ id: 'keil-release', projectId: 'stm32-project', target: 'STM32F407-Release', sourceNodeId: 'ssd', sourceRevision: 'commit-abcd', allowed: true }]
};

test('preflight trusts only the receiver owner allowlist and exact manifest identities', () => {
  assert.deepEqual(validateHandoffBuildIntent(intent), { eligible: true, profileId: 'keil-release', target: 'STM32F407-Release' });
  assert.throws(() => validateHandoffBuildIntent({ ...intent, requestedProfileId: 'downloaded-project' }), /owner|profile|allow/i);
  assert.throws(() => validateHandoffBuildIntent({ ...intent, requestedTarget: 'Debug' }), /target/i);
  assert.throws(() => validateHandoffBuildIntent({ ...intent, manifest: { ...manifest, destinationNodeId: 'other' } }), /node|destination/i);
  assert.throws(() => validateHandoffBuildIntent({ ...intent, cleanSnapshot: false }), /dirty|snapshot/i);
  assert.throws(() => validateHandoffBuildIntent({ ...intent, buildHooks: ['post-build.sh'] }), /hook/i);
  assert.throws(() => validateHandoffBuildIntent({ ...intent, sourceRevision: 'modified' }), /revision/i);
});
