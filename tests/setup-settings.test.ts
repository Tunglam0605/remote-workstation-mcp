import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ensureDefaultPolicy,
  loadSetupSettings,
  executionTargetModePreset,
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
  assert.equal(settings.execution.workerRoutingProfile, 'direct');
  assert.equal(settings.execution.targetMode, 'rwmcp-only');
  assert.equal(settings.execution.codexEnabled, false);
  assert.equal(settings.execution.codexModel, 'gpt-6-sol');
  assert.equal(settings.execution.codexAgentsEnabled, false);
  assert.equal(settings.execution.codexSkillsEnabled, false);
  assert.equal(settings.execution.antigravityEnabled, false);
  assert.equal(settings.execution.antigravityModel, '');
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
  const routed = normalizeSetupSettings({ ...settings, execution: { ...settings.execution, defaultMode: 'both', workerRoutingProfile: 'smart', codexEnabled: true, antigravityEnabled: true } }, options);
  await saveSetupSettings(routed, options);
  assert.deepEqual((await loadSetupSettings(options)).execution, routed.execution);
});

test('setup settings infer routing profiles for pre-v0.35 execution settings', () => {
  const workspace = path.resolve('tmp-workspace-routing');
  assert.equal(normalizeSetupSettings({ workspaceRoot: workspace, execution: { codexEnabled: false, defaultMode: 'both' } }).execution.workerRoutingProfile, 'direct');
  assert.equal(normalizeSetupSettings({ workspaceRoot: workspace, execution: { codexEnabled: true, antigravityEnabled: false, defaultMode: 'both' } }).execution.workerRoutingProfile, 'codex-assisted');
  assert.equal(normalizeSetupSettings({ workspaceRoot: workspace, execution: { codexEnabled: true, antigravityEnabled: true, defaultMode: 'both' } }).execution.workerRoutingProfile, 'smart');
  assert.equal(normalizeSetupSettings({ workspaceRoot: workspace, execution: { codexEnabled: true, antigravityEnabled: true, defaultMode: 'codex-only', workerRoutingProfile: 'custom' } }).execution.workerRoutingProfile, 'custom');
});

test('execution target presets derive compatible provider enablement and safety ceilings', () => {
  assert.deepEqual(executionTargetModePreset('rwmcp-only'), { targetMode: 'rwmcp-only', workerRoutingProfile: 'direct', codexEnabled: false, antigravityEnabled: false, defaultMode: 'rwmcp-only' });
  assert.deepEqual(executionTargetModePreset('codex-only'), { targetMode: 'codex-only', workerRoutingProfile: 'codex-assisted', codexEnabled: true, antigravityEnabled: false, defaultMode: 'codex-only' });
  assert.deepEqual(executionTargetModePreset('antigravity-only'), { targetMode: 'antigravity-only', workerRoutingProfile: 'custom', codexEnabled: false, antigravityEnabled: true, defaultMode: 'both' });
  assert.deepEqual(executionTargetModePreset('rwmcp-codex'), { targetMode: 'rwmcp-codex', workerRoutingProfile: 'codex-assisted', codexEnabled: true, antigravityEnabled: false, defaultMode: 'both' });
  assert.deepEqual(executionTargetModePreset('rwmcp-antigravity'), { targetMode: 'rwmcp-antigravity', workerRoutingProfile: 'custom', codexEnabled: false, antigravityEnabled: true, defaultMode: 'both' });
  assert.deepEqual(executionTargetModePreset('codex-antigravity'), { targetMode: 'codex-antigravity', workerRoutingProfile: 'custom', codexEnabled: true, antigravityEnabled: true, defaultMode: 'both' });
  assert.equal(executionTargetModePreset('auto').workerRoutingProfile, 'smart');
  assert.equal(executionTargetModePreset('all-three').workerRoutingProfile, 'smart');
});

test('setup settings migrate legacy routing into unified three-target modes', () => {
  const workspace = path.resolve('tmp-workspace-target-routing');
  assert.equal(normalizeSetupSettings({ workspaceRoot: workspace, execution: { codexEnabled: false, antigravityEnabled: false, defaultMode: 'rwmcp-only' } }).execution.targetMode, 'rwmcp-only');
  assert.equal(normalizeSetupSettings({ workspaceRoot: workspace, execution: { codexEnabled: true, antigravityEnabled: false, defaultMode: 'both', workerRoutingProfile: 'codex-assisted' } }).execution.targetMode, 'rwmcp-codex');
  assert.equal(normalizeSetupSettings({ workspaceRoot: workspace, execution: { codexEnabled: false, antigravityEnabled: true, defaultMode: 'both', workerRoutingProfile: 'custom' } }).execution.targetMode, 'rwmcp-antigravity');
  assert.equal(normalizeSetupSettings({ workspaceRoot: workspace, execution: { codexEnabled: true, antigravityEnabled: true, defaultMode: 'both', workerRoutingProfile: 'smart' } }).execution.targetMode, 'auto');
  assert.equal(normalizeSetupSettings({ workspaceRoot: workspace, execution: { codexEnabled: true, antigravityEnabled: true, defaultMode: 'both', targetMode: 'codex-antigravity' } }).execution.targetMode, 'codex-antigravity');
  assert.equal(normalizeSetupSettings({ workspaceRoot: workspace, execution: { codexEnabled: false, antigravityEnabled: true, defaultMode: 'both', targetMode: 'antigravity-only' } }).execution.targetMode, 'antigravity-only');
});

test('generic target policy migrates legacy Codex settings and preserves explicit Antigravity budgets', () => {
  const workspace = path.resolve('tmp-workspace-target-policy');
  const legacy = normalizeSetupSettings({
    workspaceRoot: workspace,
    execution: {
      codexEnabled: true,
      antigravityEnabled: true,
      defaultMode: 'both',
      workerRoutingProfile: 'smart',
      targetMode: 'auto',
      codexFallback: 'stop',
      maxCodexTasksPerSession: 4,
      maxCodexTasksPerDay: 12
    }
  });
  assert.deepEqual(legacy.execution.targetPolicy.enabledTargets, ['rwmcp-direct', 'codex-local', 'antigravity-local']);
  assert.equal(legacy.execution.targetPolicy.fallback, 'stop');
  assert.deepEqual(legacy.execution.targetPolicy.budgets['codex-local'], { maxTasksPerSession: 4, maxTasksPerDay: 12 });
  assert.deepEqual(legacy.execution.targetPolicy.budgets['antigravity-local'], { maxTasksPerSession: 0, maxTasksPerDay: 0 });

  const generic = normalizeSetupSettings({
    workspaceRoot: workspace,
    execution: {
      targetMode: 'all-three',
      targetPolicy: {
        enabledTargets: ['rwmcp-direct', 'codex-local', 'antigravity-local'],
        fallback: 'rwmcp-direct',
        budgets: {
          'rwmcp-direct': { maxTasksPerSession: 0, maxTasksPerDay: 0 },
          'codex-local': { maxTasksPerSession: 2, maxTasksPerDay: 8 },
          'antigravity-local': { maxTasksPerSession: 3, maxTasksPerDay: 9 }
        }
      }
    }
  });
  assert.equal(generic.execution.codexEnabled, true);
  assert.equal(generic.execution.antigravityEnabled, true);
  assert.equal(generic.execution.codexFallback, 'rwmcp-only');
  assert.equal(generic.execution.maxCodexTasksPerSession, 2);
  assert.equal(generic.execution.maxCodexTasksPerDay, 8);
  assert.deepEqual(generic.execution.targetPolicy.budgets['antigravity-local'], { maxTasksPerSession: 3, maxTasksPerDay: 9 });
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
