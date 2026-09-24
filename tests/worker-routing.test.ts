import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExecutionPolicyStatus } from '../src/execution-policy.js';
import type { SetupSettings } from '../src/setup/settings.js';
import type { WorkerProviderStatus } from '../src/worker-provider.js';
import { planWorkerRoute } from '../src/worker-routing.js';

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

test('direct profile always keeps execution on RWMCP', () => {
  const plan = planWorkerRoute({
    settings: execution({ workerRoutingProfile: 'direct' }),
    status: status(),
    providers: readyProviders,
    intent: 'frontend-ui'
  });
  assert.equal(plan.selected, 'rwmcp-direct');
  assert.equal(plan.canDispatchWorker, false);
  assert.deepEqual(plan.fallbackChain, ['rwmcp-direct']);
});

test('codex-assisted selects Codex and falls back to RWMCP when Codex is unavailable', () => {
  const ready = planWorkerRoute({
    settings: execution({ workerRoutingProfile: 'codex-assisted', antigravityEnabled: false }),
    status: status(),
    providers: readyProviders,
    intent: 'coding'
  });
  assert.equal(ready.selected, 'codex-local');

  const unavailable = planWorkerRoute({
    settings: execution({ workerRoutingProfile: 'codex-assisted', antigravityEnabled: false }),
    status: status(),
    providers: [provider('codex-local', false), provider('antigravity-local')],
    intent: 'coding'
  });
  assert.equal(unavailable.selected, 'rwmcp-direct');
});

test('smart routing prefers Antigravity only for frontend UI work', () => {
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
  assert.equal(plan.candidates[0]?.target, 'antigravity-local');
  assert.equal(plan.candidates[0]?.ready, false);
});

test('effective rwmcp-only mode prevents Codex dispatch even when provider is available', () => {
  const plan = planWorkerRoute({
    settings: execution({ workerRoutingProfile: 'codex-assisted' }),
    status: status({ effectiveMode: 'rwmcp-only', source: 'fallback-latch', fallbackActive: true }),
    providers: readyProviders,
    intent: 'coding'
  });
  assert.equal(plan.selected, 'rwmcp-direct');
  assert.equal(plan.candidates.find(item => item.target === 'codex-local')?.ready, false);
});

test('stop fallback is selected when the chosen provider is unavailable and owner disabled RWMCP fallback', () => {
  const plan = planWorkerRoute({
    settings: execution({ workerRoutingProfile: 'codex-assisted', codexFallback: 'stop' }),
    status: status({ codexFallback: 'stop' }),
    providers: [provider('codex-local', false)],
    intent: 'review'
  });
  assert.equal(plan.selected, 'stop');
  assert.equal(plan.canDispatchWorker, false);
});
