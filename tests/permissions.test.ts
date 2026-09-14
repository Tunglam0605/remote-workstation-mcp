import assert from 'node:assert/strict';
import test from 'node:test';
import type { PermissionLease, PolicyConfig } from '../src/model.js';
import { PolicyEngine } from '../src/policy.js';

function baseConfig(): PolicyConfig {
  return {
    version: 1,
    mode: 'workspace',
    workspaces: [{ id: 'w', root: '/tmp' }],
    filesystem: { maxReadBytes: 1024, maxWriteBytes: 1024 },
    process: { allowExecutables: ['git'], inheritEnv: [], maxOutputBytes: 1024, maxRuntimeMs: 1000 },
    fullControl: { allowRawShell: false, allowHostFilesystem: false },
    privileged: { allowSudo: false, maxRuntimeMs: 1000 }
  };
}

function lease(overrides: Partial<PermissionLease> = {}): PermissionLease {
  const now = Date.now();
  return {
    mode: 'full_control',
    issuedAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
    clientId: 'client-a',
    ...overrides
  };
}

test('active client-bound lease elevates only matching client', () => {
  const matching = new PolicyEngine(baseConfig(), lease(), 'client-a');
  const different = new PolicyEngine(baseConfig(), lease(), 'client-b');
  assert.equal(matching.effectiveMode(), 'full_control');
  assert.equal(different.effectiveMode(), 'workspace');
});

test('expired lease never elevates', () => {
  const expired = lease({ expiresAt: new Date(Date.now() - 1000).toISOString() });
  const policy = new PolicyEngine(baseConfig(), expired, 'client-a');
  assert.equal(policy.effectiveMode(), 'workspace');
});

test('full-control lease does not bypass explicit dangerous feature gates', () => {
  const policy = new PolicyEngine(baseConfig(), lease(), 'client-a');
  assert.throws(() => policy.assertRawShell(), /allowRawShell=false/);
  assert.throws(() => policy.assertHostFilesystem(), /allowHostFilesystem=false/);
  assert.throws(() => policy.assertSudo(), /allowSudo=false/);

  const config = baseConfig();
  config.fullControl = { allowRawShell: true, allowHostFilesystem: true };
  config.privileged = { allowSudo: true, maxRuntimeMs: 1000 };
  const enabled = new PolicyEngine(config, lease(), 'client-a');
  assert.doesNotThrow(() => enabled.assertRawShell());
  assert.doesNotThrow(() => enabled.assertHostFilesystem());
  assert.doesNotThrow(() => enabled.assertSudo());
});
