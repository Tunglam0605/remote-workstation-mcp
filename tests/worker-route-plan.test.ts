import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExecutionPolicyStatus } from '../src/execution-policy.js';
import type { SetupSettings } from '../src/setup/settings.js';
import type { WorkerProviderStatus } from '../src/worker-provider.js';
import { planWorkerRoute } from '../src/worker-route-plan.js';

function execution(overrides: Partial<SetupSettings['execution']> = {}): SetupSettings['execution'] {
  return {
    codexEnabled: true,
    codexModel: 'gpt-6-sol',
    codexAgentsEnabled: true,
    codexSkillsEnabled: true,
    antigravityEnabled: true,
    antigravityModel: '',
    workerRoutingProfile: 'smart',
    defaultMode: 'both',
    allowChatOverride: true,
    codexFallback: 'rwmcp-only',
    maxCodexTasksPerSession: 0,
    maxCodexTasksPerDay: 0,
    codexAccountBroker: { enabled: true, mode: 'cockpit-api-pool' },
    ...overrides
  };
}

function status(overrides: Partial<ExecutionPolicyStatus> = {}): ExecutionPolicyStatus {
  return {
    configuredMode: 'both',
    effectiveMode: 'both',
    source: 'owner-default',
    codexEnabled: true,
    allowChatOverride: true,
    codexFallback: 'rwmcp-only',
    fallbackActive: false,
    codexTasksToday: 0,
    codexTasksThisSession: 0,
    maxCodexTasksPerDay: 0,
    maxCodexTasksPerSession: 0,
    activeSessionOverrides: 0,
    activeSessionFallbacks: 0,
    ...overrides
  };
}

function provider(id: 'codex-local' | 'antigravity-local', available = true): WorkerProviderStatus {
  return {
    provider: {
      id,
      kind: id === 'codex-local' ? 'codex' : 'antigravity',
      displayName: id,
      worktreeAssignment: true,
      progressReporting: false,
      cancellationIntent: false
    },
    availability: available ? 'available' : 'unavailable',
    dispatchCapable: available,
    executionActive: false,
    activeDispatches: 0,
    authority: 'registry-only'
  };
}

const readyProviders = [provider('codex-local'), provider('antigravity-local')];

test('direct profile and workstation/read intents remain direct', () => {
  for (const intent of ['read', 'workstation'] as const) {
    const plan = planWorkerRoute({ settings: execution(), status: status(), providers: readyProviders, intent });
    assert.equal(plan.selected, 'rwmcp-direct');
    assert.equal(plan.canDispatchWorker, false);
  }
  const direct = planWorkerRoute({
    settings: execution({ workerRoutingProfile: 'direct' }),
    status: status(),
    providers: readyProviders,
    intent: 'frontend-ui'
  });
  assert.equal(direct.selected, 'rwmcp-direct');
});

test('codex-assisted selects Codex and respects direct fallback', () => {
  const ready = planWorkerRoute({
    settings: execution({ workerRoutingProfile: 'codex-assisted' }),
    status: status(),
    providers: readyProviders,
    intent: 'coding'
  });
  assert.equal(ready.selected, 'codex-local');

  const unavailable = planWorkerRoute({
    settings: execution({ workerRoutingProfile: 'codex-assisted' }),
    status: status(),
    providers: [provider('codex-local', false)],
    intent: 'coding'
  });
  assert.equal(unavailable.selected, 'rwmcp-direct');
});

test('smart routing prefers Antigravity for frontend UI and Codex for coding', () => {
  const frontend = planWorkerRoute({
    settings: execution(),
    status: status(),
    providers: readyProviders,
    intent: 'frontend-ui'
  });
  assert.equal(frontend.selected, 'antigravity-local');
  assert.deepEqual(frontend.fallbackChain, ['antigravity-local', 'codex-local', 'rwmcp-direct']);

  const coding = planWorkerRoute({
    settings: execution(),
    status: status(),
    providers: readyProviders,
    intent: 'coding'
  });
  assert.equal(coding.selected, 'codex-local');
  assert.deepEqual(coding.fallbackChain, ['codex-local', 'rwmcp-direct']);
});

test('smart routing falls back from unavailable Antigravity to Codex', () => {
  const plan = planWorkerRoute({
    settings: execution(),
    status: status(),
    providers: [provider('codex-local'), provider('antigravity-local', false)],
    intent: 'frontend-ui'
  });
  assert.equal(plan.selected, 'codex-local');
  assert.equal(plan.candidates[0]?.ready, false);
});

test('effective Work Session policy and Codex budgets are authoritative', () => {
  const fallback = planWorkerRoute({
    settings: execution({ workerRoutingProfile: 'codex-assisted' }),
    status: status({ effectiveMode: 'rwmcp-only', source: 'fallback-latch', fallbackActive: true }),
    providers: readyProviders,
    intent: 'coding'
  });
  assert.equal(fallback.selected, 'rwmcp-direct');

  const budget = planWorkerRoute({
    settings: execution({ workerRoutingProfile: 'codex-assisted' }),
    status: status({ maxCodexTasksPerDay: 1, codexTasksToday: 1 }),
    providers: readyProviders,
    intent: 'review'
  });
  assert.equal(budget.selected, 'rwmcp-direct');
});

test('custom profile follows effective low-level policy and stop fallback', () => {
  const codexOnly = planWorkerRoute({
    settings: execution({ workerRoutingProfile: 'custom', codexFallback: 'stop' }),
    status: status({ effectiveMode: 'codex-only', codexFallback: 'stop' }),
    providers: [provider('codex-local', false), provider('antigravity-local')],
    intent: 'frontend-ui'
  });
  assert.equal(codexOnly.selected, 'stop');
  assert.equal(codexOnly.canDispatchWorker, false);
});
