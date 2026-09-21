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

test('Linux installer standardizes MCP 8683 and gives Ubuntu Desktop both WebUI and TUI', async () => {
  const install = await fs.readFile('scripts/install-user.sh', 'utf8');
  const direct = await fs.readFile('scripts/setup-direct-node-linux.sh', 'utf8');
  assert.match(install, /RWMCP_PORT=8683/);
  assert.match(install, /remote-workstation-mcp-control-center\.service/);
  assert.match(install, /RWMCP_SETUP_PORT=8684/);
  assert.match(install, /setup-web-cli\.js --persistent --no-open --port 8684 --strict-port/);
  assert.match(install, /linux_desktop_detected/);
  assert.match(install, /rwmcp-webui/);
  assert.match(install, /rwmcp-tui/);
  assert.match(direct, /PORT="8683"/);
  assert.doesNotMatch(direct, /PORT="8765"/);
});

test('Linux Web Control Center shares Direct Node settings and systemd runtime control', async () => {
  const source = await fs.readFile('src/setup/setup-server.ts', 'utf8');
  assert.match(source, /linuxOpenAiEnvPath/);
  assert.match(source, /CONTROL_PLANE_API_KEY/);
  assert.match(source, /RWMCP_HTTP_SCOPES/);
  assert.match(source, /linuxRuntimeControl/);
  assert.match(source, /systemctl/);
  assert.match(source, /safeRuntimeStatus/);
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

test('first-run UX keeps new-machine setup to tunnel ID + runtime key and automates the rest', async () => {
  const tui = await fs.readFile('src/tui-cli.ts', 'utf8');
  const config = await fs.readFile('src/tui/config.ts', 'utf8');
  const install = await fs.readFile('scripts/install-user.sh', 'utf8');
  const bootstrap = await fs.readFile('scripts/install-linux.sh', 'utf8');
  const release = await fs.readFile('.github/workflows/release.yml', 'utf8');
  assert.match(tui, /Connect this workstation to ChatGPT/);
  assert.match(tui, /Connection setup/);
  assert.match(tui, /bootstrapManagedNode/);
  assert.match(config, /setup-direct-node-linux\.sh/);
  assert.match(config, /AutoUpdateOn/);
  assert.match(config, /RWMCP_UPDATE_MODE: 'auto_patch'/);
  assert.match(install, /RWMCP_UPDATE_MODE=auto_patch/);
  assert.match(bootstrap, /Node\.js >=22 not found/);
  assert.match(bootstrap, /sha256sum -c/);
  assert.match(bootstrap, /export PATH=\"\$BIN_DIR:\$PATH\"/);
  assert.match(bootstrap, /scripts\/install-user\.sh/);
  assert.match(release, /install-linux\.sh/);
});

test('Linux updater reconstructs the user-systemd bus for non-interactive restart', async () => {
  const updater = await fs.readFile('scripts/update-user.mjs', 'utf8');
  assert.match(updater, /XDG_RUNTIME_DIR/);
  assert.match(updater, /DBUS_SESSION_BUS_ADDRESS/);
  assert.match(updater, /env: linuxUserSystemdEnv\(\)/);
});

test('Linux updater resolves npm independently of a sparse systemd PATH', async () => {
  const updater = await fs.readFile('scripts/update-user.mjs', 'utf8');
  assert.match(updater, /async function resolveNpmExecutable\(\)/);
  assert.match(updater, /path\.dirname\(process\.execPath\)/);
  assert.match(updater, /path\.join\(home, '\.local', 'bin', name\)/);
  assert.match(updater, /const npm = await resolveNpmExecutable\(\)/);
  assert.match(updater, /await exec\(npm, \['install'/);
});

test('Ubuntu TUI distinguishes runtime restart from owner-approved host reboot', async () => {
  const tui = await fs.readFile('src/tui-cli.ts', 'utf8');
  const approvals = await fs.readFile('src/tui/admin-requests.ts', 'utf8');
  assert.match(tui, /label: 'Admin requests'/);
  assert.match(tui, /RWMCP only/);
  assert.match(tui, /CONFIRM HOST REBOOT/);
  assert.match(approvals, /sudo/);
  assert.match(approvals, /--no-block/);
  assert.match(approvals, /restricted to the typed host reboot request/);
});
