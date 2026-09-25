import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkerProviderRegistry, type WorkerProvider } from '../src/worker-provider.js';

test('Worker Provider Registry is empty by default and dispatch fails closed without a registered provider', async () => {
  const registry = new WorkerProviderRegistry();
  assert.deepEqual(registry.descriptors(), []);
  assert.deepEqual(await registry.listStatus(), []);
  assert.equal('execute' in registry, false);
  await assert.rejects(
    registry.dispatch('missing-worker', {
      version: 1,
      workSessionId: '55555555-5555-4555-8555-555555555555',
      objective: { id: 'objective-1', name: 'Objective', objective: 'Do bounded work' },
      task: { id: 'task-1', generation: 1, title: 'Task' }
    }),
    /Unknown worker provider missing-worker/
  );
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
  assert.equal(statuses[0].dispatchCapable, false);
  assert.equal(statuses[0].executionActive, false);
  assert.equal(statuses[0].authority, 'registry-only');
  assert.equal(statuses[1].availability, 'available');
  assert.equal(statuses[1].dispatchCapable, false);
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


test('Worker Provider Registry reports bounded active dispatch state only for the callback lifetime', async () => {
  let entered!: () => void;
  let release!: () => void;
  const running = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const registry = new WorkerProviderRegistry();
  registry.register({
    descriptor: {
      id: 'active-worker',
      kind: 'custom',
      displayName: 'Active Worker',
      worktreeAssignment: false,
      progressReporting: true,
      cancellationIntent: false
    },
    status: async () => ({ availability: 'available' as const }),
    dispatch: async () => {
      entered();
      await gate;
      return { status: 'succeeded' as const, runId: 'active-run' };
    }
  });

  const execution = registry.dispatch('active-worker', {
    version: 1,
    workSessionId: '55555555-5555-4555-8555-555555555555',
    objective: { id: 'objective-1', name: 'Objective', objective: 'Do bounded work' },
    task: { id: 'task-1', generation: 1, title: 'Task' }
  });
  await running;

  const active = (await registry.listStatus())[0]!;
  assert.equal(active.dispatchCapable, true);
  assert.equal(active.executionActive, true);
  assert.equal(active.activeDispatches, 1);

  release();
  await execution;

  const completed = (await registry.listStatus())[0]!;
  assert.equal(completed.executionActive, false);
  assert.equal(completed.activeDispatches, 0);
});


test('Worker Provider Registry aborts only the matching task generation and clears active state', async () => {
  let entered!: () => void;
  const running = new Promise<void>(resolve => { entered = resolve; });
  const registry = new WorkerProviderRegistry();
  registry.register({
    descriptor: {
      id: 'cancel-worker', kind: 'custom', displayName: 'Cancel Worker',
      worktreeAssignment: false, progressReporting: false, cancellationIntent: true
    },
    status: async () => ({ availability: 'available' as const }),
    dispatch: async (_request, context) => {
      entered();
      await new Promise<void>(resolve => {
        if (context?.signal.aborted) return resolve();
        context?.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return { status: context?.signal.aborted ? 'cancelled' as const : 'succeeded' as const, summary: 'provider-exit' };
    }
  });
  const request = {
    version: 1 as const,
    workSessionId: '55555555-5555-4555-8555-555555555555',
    objective: { id: 'objective-1', name: 'Objective', objective: 'Do bounded work' },
    task: { id: 'task-1', generation: 3, title: 'Task' }
  };
  const execution = registry.dispatch('cancel-worker', request);
  await running;
  assert.equal((await registry.listStatus())[0]?.activeDispatches, 1);
  assert.deepEqual(
    registry.cancelTaskDispatch(request.workSessionId, request.objective.id, request.task.id, 2),
    { requested: false, providerIds: [], activeDispatches: 0 }
  );
  const cancel = registry.cancelTaskDispatch(request.workSessionId, request.objective.id, request.task.id, 3);
  assert.equal(cancel.requested, true);
  assert.deepEqual(cancel.providerIds, ['cancel-worker']);
  assert.equal(cancel.activeDispatches, 1);
  assert.equal((await execution).status, 'cancelled');
  assert.equal((await registry.listStatus())[0]?.activeDispatches, 0);
});
