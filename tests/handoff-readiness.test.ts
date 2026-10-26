import assert from 'node:assert/strict';
import test from 'node:test';
import { planHandoffTransport } from '../src/adapters/engineering/handoff-readiness.js';

const input = {
  bytes: 8 * 1024 * 1024,
  source: { nodeId: 'ssd', online: true, authorizedGrant: true, dedicatedScope: true, multiNodeEnabled: true, relayCapable: true },
  destination: { nodeId: 'laptop', online: true, authorizedGrant: true, dedicatedScope: true, multiNodeEnabled: true, relayCapable: true },
  grant: { id: 'ssd-to-laptop', maxBytes: 512 * 1024 * 1024, transports: ['direct', 'relay'] as ('direct' | 'relay')[] },
  verifiedDirectPeerRoute: false, receiverReady: false
};

test('handoff transport selects verified direct route or bounded authenticated relay', () => {
  assert.equal(planHandoffTransport(input).transport, 'relay');
  assert.equal(planHandoffTransport({ ...input, verifiedDirectPeerRoute: true, receiverReady: true }).transport, 'direct');
  assert.match(planHandoffTransport({ ...input, bytes: 50 * 1024 * 1024 }).reasons.join(' '), /direct|receiver|32 MiB|route/i);
});

test('handoff readiness fails closed if either owner grant, scope, policy or connection is absent', () => {
  for (const change of [
    { source: { ...input.source, authorizedGrant: false } },
    { destination: { ...input.destination, dedicatedScope: false } },
    { destination: { ...input.destination, online: false } },
    { source: { ...input.source, multiNodeEnabled: false } }
  ]) {
    const planned = planHandoffTransport({ ...input, ...change });
    assert.equal(planned.eligible, false);
    assert.equal(planned.transport, undefined);
  }
});
