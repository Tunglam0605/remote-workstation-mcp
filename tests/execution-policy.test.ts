import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ExecutionPolicyService, isCodexLimitSignal, isWorkerCapacitySignal } from '../src/execution-policy.js';
import { normalizeSetupSettings } from '../src/setup/settings.js';

function settings(overrides: Partial<ReturnType<typeof normalizeSetupSettings>['execution']> = {}) {
  const base = normalizeSetupSettings({
    mcpPort: 8683,
    controlPort: 8684,
    workspaceRoot: path.resolve('/tmp/rwmcp-execution-policy-workspace'),
    execution: {
      codexEnabled: true,
      defaultMode: 'rwmcp-only',
      allowChatOverride: true,
      codexFallback: 'rwmcp-only',
      maxCodexTasksPerSession: 0,
      maxCodexTasksPerDay: 0,
      ...overrides
    }
  });
  return base;
}

test('execution policy uses owner default unless an explicitly allowed Work Session override exists', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-execution-policy-'));
  let owner = settings();
  const service = new ExecutionPolicyService({
    file: path.join(root, 'state.json'),
    now: () => new Date('2026-09-21T01:00:00.000Z'),
    loadSettings: async () => owner
  });
  const sessionId = '11111111-1111-4111-8111-111111111111';

  assert.equal((await service.status(sessionId)).effectiveMode, 'rwmcp-only');

  const overridden = await service.setSessionOverride(sessionId, 'both');
  assert.equal(overridden.effectiveMode, 'both');
  assert.equal(overridden.source, 'work-session-override');
  assert.equal(overridden.activeSessionOverrides, 1);

  const cleared = await service.setSessionOverride(sessionId, null);
  assert.equal(cleared.effectiveMode, 'rwmcp-only');
  assert.equal(cleared.activeSessionOverrides, 0);

  owner = settings({ allowChatOverride: false });
  await assert.rejects(
    () => service.setSessionOverride(sessionId, 'codex-only'),
    /CHAT_OVERRIDE_DISABLED/
  );
});

test('disabled Codex always forces effective rwmcp-only even if owner default requests Codex', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-execution-policy-'));
  const owner = settings({ codexEnabled: false, defaultMode: 'both' });
  const service = new ExecutionPolicyService({
    file: path.join(root, 'state.json'),
    loadSettings: async () => owner
  });
  const status = await service.status();
  assert.equal(status.configuredMode, 'both');
  assert.equal(status.effectiveMode, 'rwmcp-only');
  assert.equal(status.codexEnabled, false);
});

test('Codex Work Session budget activates a durable rwmcp-only fallback latch', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-execution-policy-'));
  const owner = settings({ defaultMode: 'both', maxCodexTasksPerSession: 1 });
  const service = new ExecutionPolicyService({
    file: path.join(root, 'state.json'),
    now: () => new Date('2026-09-21T01:00:00.000Z'),
    loadSettings: async () => owner
  });
  const sessionId = '22222222-2222-4222-8222-222222222222';

  const first = await service.beforeCodexDispatch(sessionId);
  assert.equal(first.codexTasksThisSession, 1);
  assert.equal(first.effectiveMode, 'both');

  await assert.rejects(() => service.beforeCodexDispatch(sessionId), /CODEX_FALLBACK_ACTIVE/);
  const latched = await service.status(sessionId);
  assert.equal(latched.fallbackActive, true);
  assert.equal(latched.fallbackReason, 'session-budget');
  assert.equal(latched.effectiveMode, 'rwmcp-only');
  assert.equal(latched.source, 'fallback-latch');

  const sibling = await service.status('99999999-9999-4999-8999-999999999999');
  assert.equal(sibling.fallbackActive, false);
  assert.equal(sibling.effectiveMode, 'both');

  const reset = await service.resetFallback();
  assert.equal(reset.fallbackActive, false);
  assert.equal(reset.effectiveMode, 'both');
});

test('worker capacity classifier detects quota/auth/availability across Codex and Antigravity without treating permission denial as capacity', () => {
  assert.equal(isCodexLimitSignal('HTTP 429 Too Many Requests'), true);
  assert.equal(isWorkerCapacitySignal('CODEX_LIMIT_REACHED; usage limit reached for this account'), true);
  assert.equal(isWorkerCapacitySignal('CODEX_AUTH_REQUIRED; not authenticated'), true);
  assert.equal(isWorkerCapacitySignal('ANTIGRAVITY_LIMIT_REACHED; resource exhausted'), true);
  assert.equal(isWorkerCapacitySignal('ANTIGRAVITY_AUTH_REQUIRED; sign-in required'), true);
  assert.equal(isWorkerCapacitySignal('Worker provider antigravity-local is not available'), true);
  assert.equal(isWorkerCapacitySignal('ANTIGRAVITY_PERMISSION_REQUIRED; escalate_admin denied'), false);
  assert.equal(isWorkerCapacitySignal('compile failed with exit code 2'), false);
});

test('deferred Codex budget exhaustion leaves the Work Session route available for alternate AI workers', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-execution-policy-'));
  const owner = settings({ defaultMode: 'both', maxCodexTasksPerSession: 1 });
  const service = new ExecutionPolicyService({
    file: path.join(root, 'state.json'),
    now: () => new Date('2026-09-21T01:00:00.000Z'),
    loadSettings: async () => owner
  });
  const sessionId = '44444444-4444-4444-8444-444444444444';

  await service.beforeCodexDispatch(sessionId, { deferFallback: true });
  await assert.rejects(
    () => service.beforeCodexDispatch(sessionId, { deferFallback: true }),
    /CODEX_BUDGET_REACHED/
  );
  const after = await service.status(sessionId);
  assert.equal(after.fallbackActive, false);
  assert.equal(after.effectiveMode, 'both');
});


test('fallback policy stop never creates an rwmcp-only latch when budget is reached', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-execution-policy-'));
  const owner = settings({
    defaultMode: 'codex-only',
    codexFallback: 'stop',
    maxCodexTasksPerSession: 1
  });
  const service = new ExecutionPolicyService({
    file: path.join(root, 'state.json'),
    loadSettings: async () => owner
  });
  const sessionId = '33333333-3333-4333-8333-333333333333';

  await service.beforeCodexDispatch(sessionId);
  await assert.rejects(() => service.beforeCodexDispatch(sessionId), /CODEX_BUDGET_REACHED/);
  const status = await service.status(sessionId);
  assert.equal(status.fallbackActive, false);
  assert.equal(status.effectiveMode, 'codex-only');
});
