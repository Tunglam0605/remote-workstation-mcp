import assert from 'node:assert/strict';
import test from 'node:test';
import { EngineeringResourceManager } from '../src/adapters/engineering/resource-manager.js';
import { runWithWorkSession } from '../src/security/execution-context.js';

test('engineering resource manager enforces exclusive leases and owner privacy', async () => {
  let owner = 'alice';
  const manager = new EngineeringResourceManager(() => owner);
  const lease = manager.acquire('debug-probe:123', 'debugging');
  assert.equal(lease.resourceId, 'debug-probe:123');
  assert.throws(() => manager.acquire('debug-probe:123', 'flashing'), /RESOURCE_BUSY/);
  assert.equal(manager.list()[0]?.ownerId, 'alice');
  owner = 'bob';
  assert.equal(manager.list()[0]?.ownerId, 'other-principal');
  assert.throws(() => manager.release(lease.id), /Unknown engineering lease/);
  owner = 'alice';
  manager.release(lease.id);
  assert.deepEqual(manager.list(), []);
});

test('withLease always releases after failure', async () => {
  const manager = new EngineeringResourceManager('owner');
  await assert.rejects(manager.withLease('serial:COM9', 'monitoring', async () => { throw new Error('boom'); }), /boom/);
  assert.deepEqual(manager.list(), []);
});


test('same principal Work Sessions compete for exclusive resources but cannot release each other leases', () => {
  const manager = new EngineeringResourceManager('openai-tunnel');
  const sessionA = '11111111-1111-4111-8111-111111111111';
  const sessionB = '22222222-2222-4222-8222-222222222222';

  const lease = runWithWorkSession(sessionA, () =>
    manager.acquire('debug-probe:STLINK-A', 'debugging')
  );
  assert.equal(lease.ownerId, 'openai-tunnel');

  runWithWorkSession(sessionB, () => {
    assert.equal(manager.list()[0]?.ownerId, 'other-session');
    assert.throws(
      () => manager.acquire('debug-probe:STLINK-A', 'flashing'),
      /RESOURCE_BUSY/
    );
    assert.throws(() => manager.release(lease.id), /Unknown engineering lease/);
  });

  runWithWorkSession(sessionA, () => manager.release(lease.id));
  assert.deepEqual(manager.list(), []);
});
