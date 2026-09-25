import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExecutionPolicyStatus } from '../src/execution-policy.js';
import type { ExecutionTargetMode, SetupSettings } from '../src/setup/settings.js';
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
    targetMode: 'auto',
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

function plan(targetMode: ExecutionTargetMode, intent: 'general' | 'read' | 'workstation' | 'coding' | 'frontend-ui' | 'review' | 'debug') {
  return planWorkerRoute({ settings: execution({ targetMode }), status: status(), providers: readyProviders, intent });
}

test('auto mode uses affinity rather than hard capability locks', () => {
  const frontend = plan('auto', 'frontend-ui');
  assert.equal(frontend.selected, 'antigravity-local');
  assert.deepEqual(frontend.affinityOrder, ['antigravity-local', 'codex-local', 'rwmcp-direct']);
  assert.deepEqual(frontend.fallbackChain, ['antigravity-local', 'codex-local', 'rwmcp-direct']);

  const coding = plan('auto', 'coding');
  assert.equal(coding.selected, 'codex-local');
  assert.deepEqual(coding.fallbackChain, ['codex-local', 'antigravity-local', 'rwmcp-direct']);

  const workstation = plan('auto', 'workstation');
  assert.equal(workstation.selected, 'rwmcp-direct');
  assert.deepEqual(workstation.fallbackChain, ['rwmcp-direct', 'codex-local', 'antigravity-local']);
});

test('all explicit single-target modes select only that peer target', () => {
  assert.deepEqual(plan('rwmcp-only', 'coding').fallbackChain, ['rwmcp-direct']);
  assert.deepEqual(plan('codex-only', 'frontend-ui').fallbackChain, ['codex-local']);
  assert.deepEqual(plan('antigravity-only', 'coding').fallbackChain, ['antigravity-local']);
});

test('pair target modes preserve affinity while excluding the third target', () => {
  assert.deepEqual(plan('rwmcp-codex', 'coding').fallbackChain, ['codex-local', 'rwmcp-direct']);
  assert.deepEqual(plan('rwmcp-antigravity', 'frontend-ui').fallbackChain, ['antigravity-local', 'rwmcp-direct']);
  assert.deepEqual(plan('codex-antigravity', 'workstation').fallbackChain, ['codex-local', 'antigravity-local']);
});

test('all-three is an explicit all-target set with the same affinity order as auto', () => {
  assert.deepEqual(plan('all-three', 'frontend-ui').fallbackChain, ['antigravity-local', 'codex-local', 'rwmcp-direct']);
  assert.deepEqual(plan('all-three', 'review').fallbackChain, ['codex-local', 'antigravity-local', 'rwmcp-direct']);
});

test('unavailable preferred AI target falls through to another allowed peer', () => {
  const frontend = planWorkerRoute({
    settings: execution({ targetMode: 'all-three' }),
    status: status(),
    providers: [provider('codex-local'), provider('antigravity-local', false)],
    intent: 'frontend-ui'
  });
  assert.equal(frontend.selected, 'codex-local');

  const coding = planWorkerRoute({
    settings: execution({ targetMode: 'codex-antigravity' }),
    status: status(),
    providers: [provider('codex-local', false), provider('antigravity-local')],
    intent: 'coding'
  });
  assert.equal(coding.selected, 'antigravity-local');
});

test('Codex budget exhaustion falls through without disabling Antigravity', () => {
  const routed = planWorkerRoute({
    settings: execution({ targetMode: 'codex-antigravity' }),
    status: status({ maxCodexTasksPerDay: 1, codexTasksToday: 1 }),
    providers: readyProviders,
    intent: 'coding'
  });
  assert.equal(routed.selected, 'antigravity-local');
  assert.equal(routed.candidates[0]?.ready, false);
  assert.equal(routed.candidates[1]?.ready, true);
});

test('legacy Work Session safety ceiling narrows but never widens the owner target set', () => {
  const direct = planWorkerRoute({
    settings: execution({ targetMode: 'all-three' }),
    status: status({ effectiveMode: 'rwmcp-only' }),
    providers: readyProviders,
    intent: 'coding'
  });
  assert.deepEqual(direct.fallbackChain, ['rwmcp-direct']);

  const codex = planWorkerRoute({
    settings: execution({ targetMode: 'all-three' }),
    status: status({ effectiveMode: 'codex-only' }),
    providers: readyProviders,
    intent: 'frontend-ui'
  });
  assert.deepEqual(codex.fallbackChain, ['codex-local']);

  const blocked = planWorkerRoute({
    settings: execution({ targetMode: 'antigravity-only', codexEnabled: false }),
    status: status({ effectiveMode: 'codex-only' }),
    providers: readyProviders,
    intent: 'frontend-ui'
  });
  assert.equal(blocked.selected, 'stop');
});

test('Antigravity-only remains usable with Codex disabled when safety ceiling is hybrid', () => {
  const routed = planWorkerRoute({
    settings: execution({ targetMode: 'antigravity-only', codexEnabled: false, workerRoutingProfile: 'custom' }),
    status: status({ effectiveMode: 'both', codexEnabled: false }),
    providers: readyProviders,
    intent: 'coding'
  });
  assert.equal(routed.selected, 'antigravity-local');
  assert.deepEqual(routed.fallbackChain, ['antigravity-local']);
});
