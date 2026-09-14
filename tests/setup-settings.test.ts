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
  assert.equal(settings.tunnelId, 'tunnel_0123456789abcdef0123456789abcdef');
  assert.throws(() => normalizeSetupSettings({ mcpPort: 80, workspaceRoot: workspace }), /1024/);
  assert.throws(() => normalizeSetupSettings({ mcpPort: 8683, workspaceRoot: 'relative/path' }), /absolute/);
  assert.throws(() => normalizeSetupSettings({ mcpPort: 8683, workspaceRoot: workspace, tunnelId: 'tunnel_bad' }), /tunnelId/);
});

test('setup settings persist outside the repository and round-trip', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-settings-'));
  const options = { env: { XDG_CONFIG_HOME: base } as NodeJS.ProcessEnv, platform: 'linux' as NodeJS.Platform, homeDir: base };
  const settings = normalizeSetupSettings({
    mcpPort: 8877,
    workspaceRoot: path.join(base, 'workspace'),
    tunnelId: '',
    organizationId: '',
    cloudflaredManaged: false
  }, options);
  const file = await saveSetupSettings(settings, options);
  assert.equal(file, setupSettingsPath(options));
  assert.deepEqual(await loadSetupSettings(options), settings);
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
