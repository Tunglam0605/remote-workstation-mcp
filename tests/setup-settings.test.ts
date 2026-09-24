import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ensureDefaultPolicy,
  loadSetupSettings,
  normalizeSetupSettings,
  saveSetupSettings,
  setupSettingsPath
} from '../src/setup/settings.js';

test('setup settings validate ports, absolute workspace paths and tunnel ids', () => {
  const workspace = path.resolve('tmp-workspace');
  const settings = normalizeSetupSettings({
    mcpPort: 8683,
    workspaceRoot: workspace,
    tunnelId: 'tunnel_0123456789abcdef0123456789abcdef',
    organizationId: 'org-example123',
    cloudflaredManaged: false
  });
  assert.equal(settings.mcpPort, 8683);
  assert.equal(settings.controlPort, 8684);
  assert.deepEqual(settings.httpScopes, ['workstation.read', 'workstation.write', 'workstation.execute', 'workstation.admin_request']);
  assert.equal(settings.tunnelId, 'tunnel_0123456789abcdef0123456789abcdef');
  assert.equal(settings.execution.defaultMode, 'rwmcp-only');
  assert.equal(settings.execution.codexEnabled, false);
  assert.equal(settings.execution.codexModel, 'gpt-6-sol');
  assert.equal(settings.execution.codexAgentsEnabled, false);
  assert.equal(settings.execution.codexSkillsEnabled, false);
  assert.equal(settings.execution.antigravityEnabled, false);
  assert.equal(settings.execution.antigravityModel, '');
  assert.equal(settings.execution.workerRoutingProfile, 'direct');
  assert.equal(settings.execution.allowChatOverride, true);
  assert.equal(settings.execution.codexFallback, 'rwmcp-only');
  assert.deepEqual(settings.execution.codexAccountBroker, { enabled: false, mode: 'native' });
  assert.throws(() => normalizeSetupSettings({ mcpPort: 80, workspaceRoot: workspace }), /1024/);
  assert.throws(() => normalizeSetupSettings({ mcpPort: 8683, workspaceRoot: 'relative/path' }), /absolute/);
  assert.throws(() => normalizeSetupSettings({ mcpPort: 8683, workspaceRoot: workspace, tunnelId: 'tunnel_bad' }), /tunnelId/);
  assert.throws(() => normalizeSetupSettings({ mcpPort: 8683, workspaceRoot: workspace, controlPort: 80 }), /1024/);
  assert.throws(() => normalizeSetupSettings({ mcpPort: 8683, workspaceRoot: workspace, httpScopes: ['workstation.write'] }), /workstation.read/);
  assert.throws(() => normalizeSetupSettings({ mcpPort: 8683, controlPort: 8683, workspaceRoot: workspace }), /different loopback ports/);
  assert.throws(() => normalizeSetupSettings({ mcpPort: 8683, workspaceRoot: workspace, execution: { codexModel: 'gpt-6-sol\\nmalicious=true' } }), /Invalid string|regular expression|regex/i);

  const migrated = normalizeSetupSettings({ mcpPort: 8684, workspaceRoot: workspace });
  assert.equal(migrated.controlPort, 8685);

  const legacyExecuteScopes = normalizeSetupSettings({
    mcpPort: 8683,
    workspaceRoot: workspace,
    httpScopes: ['workstation.read', 'workstation.write', 'workstation.execute']
  });
  assert.deepEqual(legacyExecuteScopes.httpScopes, ['workstation.read', 'workstation.write', 'workstation.execute', 'workstation.admin_request']);
  const legacyReadOnlyScopes = normalizeSetupSettings({
    mcpPort: 8683,
    workspaceRoot: workspace,
    httpScopes: ['workstation.read']
  });
  assert.deepEqual(legacyReadOnlyScopes.httpScopes, ['workstation.read']);
});

test('setup settings infer routing profiles for pre-v0.34 execution settings', () => {
  const workspace = path.resolve('tmp-workspace-routing');
  const smart = normalizeSetupSettings({
    workspaceRoot: workspace,
    execution: { codexEnabled: true, antigravityEnabled: true, defaultMode: 'both' }
  });
  assert.equal(smart.execution.workerRoutingProfile, 'smart');

  const codex = normalizeSetupSettings({
    workspaceRoot: workspace,
    execution: { codexEnabled: true, antigravityEnabled: false, defaultMode: 'both' }
  });
  assert.equal(codex.execution.workerRoutingProfile, 'codex-assisted');

  const direct = normalizeSetupSettings({
    workspaceRoot: workspace,
    execution: { codexEnabled: true, antigravityEnabled: true, defaultMode: 'rwmcp-only' }
  });
  assert.equal(direct.execution.workerRoutingProfile, 'direct');
});

test('setup settings persist outside the repository and round-trip', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-settings-'));
  const options = { env: { XDG_CONFIG_HOME: base } as NodeJS.ProcessEnv, platform: 'linux' as NodeJS.Platform, homeDir: base };
  const settings = normalizeSetupSettings({
    mcpPort: 8877,
    workspaceRoot: path.join(base, 'workspace'),
    tunnelId: '',
    organizationId: '',
    cloudflaredManaged: false,
    controlPort: 9684,
    httpScopes: ['workstation.read', 'workstation.execute', 'workstation.full_control']
  }, options);
  const file = await saveSetupSettings(settings, options);
  assert.equal(file, setupSettingsPath(options));
  assert.deepEqual(await loadSetupSettings(options), settings);
});


test('setup settings tolerate a UTF-8 BOM written by Windows PowerShell', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-settings-bom-'));
  const options = { env: { XDG_CONFIG_HOME: base } as NodeJS.ProcessEnv, platform: 'linux' as NodeJS.Platform, homeDir: base };
  const file = setupSettingsPath(options);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const payload = JSON.stringify({
    version: 1,
    mcpPort: 8683,
    controlPort: 8684,
    workspaceRoot: path.join(base, 'workspace'),
    tunnelId: '',
    organizationId: '',
    cloudflaredManaged: false,
    httpScopes: ['workstation.read', 'workstation.write', 'workstation.execute', 'workstation.admin_request']
  });
  await fs.writeFile(file, `\uFEFF${payload}`, 'utf8');
  const loaded = await loadSetupSettings(options);
  assert.equal(loaded.mcpPort, 8683);
  assert.equal(loaded.controlPort, 8684);
});

test('default policy bootstrap never overwrites an existing owner policy', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-policy-'));
  const workspace = path.join(repo, 'workspace');
  const first = await ensureDefaultPolicy(repo, workspace);
  assert.equal(first.created, true);
  const original = await fs.readFile(first.path, 'utf8');
  assert.match(original, /mode: workspace/);
  assert.match(original, /RemoteWorkspaces|workspace/);

  await fs.writeFile(first.path, 'version: 1\nmode: read_only\nworkspaces: []\n', 'utf8');
  const second = await ensureDefaultPolicy(repo, path.join(repo, 'other'));
  assert.equal(second.created, false);
  assert.equal(await fs.readFile(first.path, 'utf8'), 'version: 1\nmode: read_only\nworkspaces: []\n');
});
