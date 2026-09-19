import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkerProviderRegistry, type WorkerProvider } from '../src/worker-provider.js';

test('Worker Provider Registry is empty by default and exposes no execution surface', async () => {
  const registry = new WorkerProviderRegistry();
  assert.deepEqual(registry.descriptors(), []);
  assert.deepEqual(await registry.listStatus(), []);
  assert.equal('execute' in registry, false);
  assert.equal('dispatch' in registry, false);
});

test('Worker Provider Registry preserves class-instance status methods and returns bounded read-only status', async () => {
  class ClassProvider implements WorkerProvider {
    descriptor = {
      id: 'codex-local',
      kind: 'codex' as const,
      displayName: ' Codex Local ',
      worktreeAssignment: true,
      progressReporting: true,
      cancellationIntent: true
    };

    async status() {
      return { availability: 'available' as const, detail: 'ready' };
    }
  }

  const registry = new WorkerProviderRegistry(3);
  registry.register(new ClassProvider());
  registry.register({
    descriptor: {
      id: 'claude-local',
      kind: 'claude',
      displayName: 'Claude Local',
      worktreeAssignment: true,
      progressReporting: false,
      cancellationIntent: false
    },
    status: async () => { throw new Error('provider unavailable'); }
  });

  const statuses = await registry.listStatus();
  assert.deepEqual(statuses.map(item => item.provider.id), ['claude-local', 'codex-local']);
  assert.equal(statuses[0].availability, 'unavailable');
  assert.match(statuses[0].detail ?? '', /provider unavailable/);
  assert.equal(statuses[0].executionActive, false);
  assert.equal(statuses[0].authority, 'registry-only');
  assert.equal(statuses[1].availability, 'available');
  assert.equal(statuses[1].provider.displayName, 'Codex Local');
  assert.equal(statuses[1].executionActive, false);
});

test('Worker Provider Registry bounds status probes and redacts secret-like details', async () => {
  const registry = new WorkerProviderRegistry(3, 20);
  registry.register({
    descriptor: {
      id: 'slow-worker',
      kind: 'custom',
      displayName: 'Slow Worker',
      worktreeAssignment: false,
      progressReporting: false,
      cancellationIntent: false
    },
    status: async () => await new Promise(() => {})
  });
  registry.register({
    descriptor: {
      id: 'secret-worker',
      kind: 'custom',
      displayName: 'Secret Worker',
      worktreeAssignment: false,
      progressReporting: false,
      cancellationIntent: false
    },
    status: async () => ({ availability: 'available', detail: 'access_token=super-secret-provider-token' })
  });

  const statuses = await registry.listStatus();
  const secret = statuses.find(item => item.provider.id === 'secret-worker');
  const slow = statuses.find(item => item.provider.id === 'slow-worker');
  assert.equal(secret?.detail, '[redacted provider detail]');
  assert.equal(secret?.executionActive, false);
  assert.equal(slow?.availability, 'unavailable');
  assert.equal(slow?.detail, 'status probe timed out');
});

test('Worker Provider Registry rejects duplicate, invalid and over-limit registrations', () => {
  const provider = {
    descriptor: {
      id: 'custom-worker',
      kind: 'custom' as const,
      displayName: 'Custom Worker',
      worktreeAssignment: false,
      progressReporting: false,
      cancellationIntent: false
    },
    status: async () => ({ availability: 'disabled' as const })
  };

  const registry = new WorkerProviderRegistry(1);
  registry.register(provider);
  assert.throws(() => registry.register(provider), /Duplicate worker provider id/);

  const invalid = new WorkerProviderRegistry();
  assert.throws(() => invalid.register({
    ...provider,
    descriptor: { ...provider.descriptor, id: 'INVALID ID' }
  }), /Worker provider id must match/);

  assert.throws(() => invalid.register({
    ...provider,
    descriptor: { ...provider.descriptor, id: 'bad-kind', kind: 'other' as never }
  }), /Unsupported worker provider kind/);
});
