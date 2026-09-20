import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';
import {
  normalizeOwnerMultiNodeGrant,
  readOwnerMultiNodeState,
  removeOwnerMultiNodeGrant,
  setOwnerMultiNodeEnabled,
  upsertOwnerMultiNodeGrant
} from '../src/setup/multi-node.js';
import { applyOwnerPermissionMode } from '../src/setup/permissions.js';
import { loadSetupSettings, normalizeSetupSettings, saveSetupSettings } from '../src/setup/settings.js';

async function withIsolatedMultiNode(run: (ctx: { root: string; policyPath: string }) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-multi-node-owner-'));
  const previous = {
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    APPDATA: process.env.APPDATA,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    RWMCP_POLICY: process.env.RWMCP_POLICY
  };
  const policyPath = path.join(root, 'owner-policy.yaml');
  process.env.LOCALAPPDATA = root;
  process.env.APPDATA = root;
  process.env.XDG_CONFIG_HOME = root;
  process.env.RWMCP_POLICY = policyPath;
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
      workspaces: [{ id: 'projects', root: workspace, readOnly: false }],
      filesystem: { maxReadBytes: 1048576, maxWriteBytes: 1048576 },
      search: { maxResults: 100, maxFiles: 5000, maxFileBytes: 1048576 },
      process: { allowExecutables: ['git'], inheritEnv: ['PATH'], maxOutputBytes: 262144, maxRuntimeMs: 600000, maxInputBytes: 65536 },
      tasks: {},
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

const grant = {
  id: 'windows-to-vision-builds',
  sourceNodeId: 'node-windows',
  destinationNodeId: 'node-vision',
  sourceWorkspace: 'projects',
  destinationWorkspace: 'projects',
  sourcePathPrefixes: ['build\\artifacts', 'build/artifacts'],
  destinationBasePaths: ['incoming'],
  allowedExtensions: ['.BIN', '.hex'],
  maxBytes: 16 * 1024 * 1024,
  transports: ['direct', 'relay'] as const
};

test('owner multi-node state is default-deny and enablement synchronizes the dedicated scope', async () => {
  await withIsolatedMultiNode(async ({ root }) => {
    const before = await readOwnerMultiNodeState(root);
    assert.equal(before.enabled, false);
    assert.equal(before.scopeEnabled, false);
    assert.equal(before.configurationConsistent, true);
    assert.deepEqual(before.grants, []);

    const enabled = await setOwnerMultiNodeEnabled(root, true);
    assert.equal(enabled.enabled, true);
    assert.equal(enabled.scopeEnabled, true);
    assert.equal(enabled.configurationConsistent, true);
    assert.equal(enabled.restartRequired, true);
    assert.ok((await loadSetupSettings()).httpScopes.includes('workstation.cross_node_transfer'));

    const disabled = await setOwnerMultiNodeEnabled(root, false);
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.scopeEnabled, false);
    assert.equal(disabled.configurationConsistent, true);
    assert.ok(!(await loadSetupSettings()).httpScopes.includes('workstation.cross_node_transfer'));
  });
});

test('owner multi-node grants normalize bounded directional contracts and reject traversal', async () => {
  await withIsolatedMultiNode(async ({ root, policyPath }) => {
    const normalized = normalizeOwnerMultiNodeGrant(grant);
    assert.deepEqual(normalized.sourcePathPrefixes, ['build/artifacts']);
    assert.deepEqual(normalized.allowedExtensions, ['.bin', '.hex']);

    const added = await upsertOwnerMultiNodeGrant(root, grant);
    assert.equal(added.grants.length, 1);
    assert.equal(added.grants[0]?.id, grant.id);
    assert.deepEqual(added.grants[0]?.sourcePathPrefixes, ['build/artifacts']);

    const parsed = YAML.parse(await fs.readFile(policyPath, 'utf8')) as Record<string, any>;
    assert.equal(parsed.multiNode.enabled, false);
    assert.equal(parsed.multiNode.grants[0].sourceNodeId, 'node-windows');

    await assert.rejects(
      () => upsertOwnerMultiNodeGrant(root, { ...grant, id: 'bad', sourcePathPrefixes: ['../escape'] }),
      /must not contain traversal/
    );

    const removed = await removeOwnerMultiNodeGrant(root, grant.id);
    assert.deepEqual(removed.grants, []);
  });
});

test('owner access-mode changes preserve the dedicated cross-node scope', async () => {
  await withIsolatedMultiNode(async ({ root }) => {
    await setOwnerMultiNodeEnabled(root, true);

    const readOnly = await applyOwnerPermissionMode(root, 'read_only');
    assert.deepEqual(readOnly.httpScopes, ['workstation.read', 'workstation.cross_node_transfer']);

    const workspace = await applyOwnerPermissionMode(root, 'workspace');
    assert.deepEqual(workspace.httpScopes, [
      'workstation.read',
      'workstation.write',
      'workstation.execute',
      'workstation.admin_request',
      'workstation.cross_node_transfer'
    ]);

    const full = await applyOwnerPermissionMode(root, 'full_control');
    assert.deepEqual(full.httpScopes, [
      'workstation.read',
      'workstation.write',
      'workstation.execute',
      'workstation.admin_request',
      'workstation.full_control',
      'workstation.cross_node_transfer'
    ]);
  });
});
