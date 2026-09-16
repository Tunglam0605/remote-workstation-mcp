import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  linuxOpenAiEnvPath,
  parseEnvFile,
  readEnvFile,
  setMcpPort,
  setRuntimeApiKey,
  setTunnelId,
  updateEnvFile
} from '../src/tui/config.js';
import { loadSetupSettings } from '../src/setup/settings.js';

test('TUI env parser handles direct-node values without exposing secrets', () => {
  const values = parseEnvFile([
    'CONTROL_PLANE_TUNNEL_ID=tunnel_0123456789abcdef0123456789abcdef',
    'CONTROL_PLANE_API_KEY=secret-value',
    'RWMCP_PORT=8683',
    'RWMCP_DEVICE_NAME=Ubuntu\\ Personal\\ PC',
    ''
  ].join('\n'));
  assert.equal(values.get('CONTROL_PLANE_TUNNEL_ID'), 'tunnel_0123456789abcdef0123456789abcdef');
  assert.equal(values.get('RWMCP_PORT'), '8683');
  assert.equal(values.get('RWMCP_DEVICE_NAME'), 'Ubuntu Personal PC');
  assert.equal(values.get('CONTROL_PLANE_API_KEY'), 'secret-value');
});

test('TUI env updates are atomic-style and preserve unrelated direct-node settings', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-tui-env-'));
  const file = path.join(base, 'openai.env');
  await fs.writeFile(file, 'CONTROL_PLANE_API_KEY=keep-me\nRWMCP_PORT=8765\nOTHER=value\n', 'utf8');
  await updateEnvFile(file, { RWMCP_PORT: '8683', RWMCP_DEVICE_NAME: 'Ubuntu Personal PC' });
  const values = await readEnvFile(file);
  assert.equal(values.get('CONTROL_PLANE_API_KEY'), 'keep-me');
  assert.equal(values.get('RWMCP_PORT'), '8683');
  assert.equal(values.get('RWMCP_DEVICE_NAME'), 'Ubuntu Personal PC');
  assert.equal(values.get('OTHER'), 'value');
});

test('TUI writes Linux direct-node port, tunnel id and runtime key to managed config', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-tui-linux-'));
  const options = {
    platform: 'linux' as NodeJS.Platform,
    homeDir: base,
    env: { XDG_CONFIG_HOME: path.join(base, 'config') } as NodeJS.ProcessEnv
  };
  await setMcpPort(8683, options);
  await setTunnelId('tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', options);
  await setRuntimeApiKey('runtime-key-example-123456', options);

  const settings = await loadSetupSettings(options);
  assert.equal(settings.mcpPort, 8683);
  assert.equal(settings.tunnelId, 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

  const values = await readEnvFile(linuxOpenAiEnvPath(options));
  assert.equal(values.get('RWMCP_PORT'), '8683');
  assert.equal(values.get('CONTROL_PLANE_TUNNEL_ID'), 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(values.get('CONTROL_PLANE_API_KEY'), 'runtime-key-example-123456');
});

test('Linux installer and direct-node bootstrap standardize MCP port 8683 and ship TUI launcher', async () => {
  const install = await fs.readFile('scripts/install-user.sh', 'utf8');
  const direct = await fs.readFile('scripts/setup-direct-node-linux.sh', 'utf8');
  assert.match(install, /RWMCP_PORT=8683/);
  assert.match(install, /rwmcp-tui/);
  assert.match(direct, /PORT="8683"/);
  assert.doesNotMatch(direct, /PORT="8765"/);
});
test('TUI reconstructs the Linux user-systemd bus for non-interactive status and restart', async () => {
  const source = await fs.readFile('src/tui/config.ts', 'utf8');
  const installer = await fs.readFile('scripts/install-user.sh', 'utf8');
  assert.match(source, /XDG_RUNTIME_DIR/);
  assert.match(source, /DBUS_SESSION_BUS_ADDRESS/);
  assert.match(source, /linuxSystemdEnv/);
  assert.match(installer, /\/run\/user\/\$\(id -u\)/);
  assert.match(installer, /DBUS_SESSION_BUS_ADDRESS/);
});
