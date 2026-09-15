import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';
import {
  applyOwnerPermissionMode,
  applyPermissionConfig,
  grantFullControlLease,
  managedLeasePath,
  readPermissionState,
  revokePermissionLease
} from '../src/setup/permissions.js';
import { normalizeSetupSettings, saveSetupSettings } from '../src/setup/settings.js';

async function withIsolatedOwnerConfig(run: (ctx: { root: string; policyPath: string }) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-permissions-'));
  const previous = {
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    APPDATA: process.env.APPDATA,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    RWMCP_POLICY: process.env.RWMCP_POLICY,
    RWMCP_LEASE: process.env.RWMCP_LEASE
  };
  const policyPath = path.join(root, 'owner-policy.yaml');
  process.env.LOCALAPPDATA = root;
  process.env.APPDATA = root;
  process.env.XDG_CONFIG_HOME = root;
  process.env.RWMCP_POLICY = policyPath;
  delete process.env.RWMCP_LEASE;
  try {
    const workspace = path.join(root, 'workspace');
    await fs.mkdir(workspace, { recursive: true });
    await saveSetupSettings(normalizeSetupSettings({
      mcpPort: 8683,
      controlPort: 8684,
      workspaceRoot: workspace,
      tunnelId: '',
      organizationId: '',
      cloudflaredManaged: false
    }));
    await fs.writeFile(policyPath, YAML.stringify({
      version: 1,
      mode: 'workspace',
      workspaces: [{ id: 'projects', name: 'Projects', root: workspace, readOnly: false }],
      filesystem: { maxReadBytes: 1048576, maxWriteBytes: 1048576 },
      search: { maxResults: 100, maxFiles: 5000, maxFileBytes: 1048576 },
      process: { allowExecutables: ['git'], inheritEnv: ['PATH'], maxOutputBytes: 262144, maxRuntimeMs: 600000, maxInputBytes: 65536 },
      tasks: { smoke: { program: 'git', args: ['status'], cwd: '.' } },
      fullControl: { allowRawShell: false, allowHostFilesystem: false },
      privileged: { allowSudo: false, maxRuntimeMs: 600000 }
    }), 'utf8');
    await run({ root, policyPath });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('permission config updates only owner-controlled full-control gates and transport scopes', async () => {
  await withIsolatedOwnerConfig(async ({ root, policyPath }) => {
    const before = await readPermissionState(root);
    assert.equal(before.allowHostFilesystem, false);
    assert.equal(before.allowRawShell, false);
    assert.deepEqual(before.httpScopes, ['workstation.read', 'workstation.write', 'workstation.execute', 'workstation.admin_request']);

    const after = await applyPermissionConfig(root, {
      httpScopes: ['workstation.read', 'workstation.execute', 'workstation.full_control'],
      allowHostFilesystem: true,
      allowRawShell: false
    });
    assert.equal(after.allowHostFilesystem, true);
    assert.equal(after.allowRawShell, false);
    assert.deepEqual(after.httpScopes, ['workstation.read', 'workstation.write', 'workstation.execute', 'workstation.admin_request', 'workstation.full_control']);

    const parsed = YAML.parse(await fs.readFile(policyPath, 'utf8')) as Record<string, any>;
    assert.deepEqual(parsed.process.allowExecutables, ['git']);
    assert.equal(parsed.tasks.smoke.program, 'git');
    assert.equal(parsed.privileged.allowSudo, false);
    assert.equal(parsed.fullControl.allowHostFilesystem, true);
    assert.equal(parsed.fullControl.allowRawShell, false);
  });
});


test('owner permission modes map to simple safe/workspace/full-access policies', async () => {
  await withIsolatedOwnerConfig(async ({ root, policyPath }) => {
    const readOnly = await applyOwnerPermissionMode(root, 'read_only');
    assert.equal(readOnly.mode, 'read_only');
    assert.deepEqual(readOnly.httpScopes, ['workstation.read']);
    assert.equal(readOnly.allowHostFilesystem, false);
    assert.equal(readOnly.allowRawShell, false);

    const workspace = await applyOwnerPermissionMode(root, 'workspace');
    assert.equal(workspace.mode, 'workspace');
    assert.deepEqual(workspace.httpScopes, ['workstation.read', 'workstation.write', 'workstation.execute', 'workstation.admin_request']);
    assert.equal(workspace.allowHostFilesystem, false);
    assert.equal(workspace.allowRawShell, false);

    const full = await applyOwnerPermissionMode(root, 'full_control');
    assert.equal(full.mode, 'full_control');
    assert.deepEqual(full.httpScopes, ['workstation.read', 'workstation.write', 'workstation.execute', 'workstation.admin_request', 'workstation.full_control']);
    assert.equal(full.allowHostFilesystem, true);
    assert.equal(full.allowRawShell, true);

    const parsed = YAML.parse(await fs.readFile(policyPath, 'utf8')) as Record<string, any>;
    assert.equal(parsed.mode, 'full_control');
    assert.equal(parsed.fullControl.allowHostFilesystem, true);
    assert.equal(parsed.fullControl.allowRawShell, true);
    assert.equal(parsed.privileged.allowSudo, false);
  });
});

test('full-control lease is client-bound, time-limited and revocable', async () => {
  await withIsolatedOwnerConfig(async ({ root }) => {
    const lease = await grantFullControlLease(10);
    assert.equal(lease?.mode, 'full_control');
    assert.equal(lease?.clientId, 'openai-tunnel');
    assert.equal(lease?.active, true);
    assert.ok(await fs.stat(managedLeasePath()));

    const state = await readPermissionState(root);
    assert.equal(state.lease?.active, true);
    assert.equal(state.lease?.clientId, 'openai-tunnel');
    assert.ok((state.lease?.remainingSeconds ?? 0) > 0);

    await revokePermissionLease();
    const revoked = await readPermissionState(root);
    assert.equal(revoked.lease, undefined);
    await assert.rejects(() => fs.stat(managedLeasePath()), /ENOENT/);
  });
});

test('permission config always requires read scope and lease TTL is bounded to preset values', async () => {
  await withIsolatedOwnerConfig(async ({ root }) => {
    const state = await applyPermissionConfig(root, {
      httpScopes: ['workstation.write'],
      allowHostFilesystem: false,
      allowRawShell: false
    });
    assert.deepEqual(state.httpScopes, ['workstation.read', 'workstation.write']);
    await assert.rejects(() => grantFullControlLease(5), /10, 30 or 60/);
  });
});
