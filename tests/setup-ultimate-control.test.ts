import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';
import { startSetupServer } from '../src/setup/setup-server.js';
import {
  activateOwnerUltimate,
  readOwnerUltimateState,
  revokeOwnerUltimate
} from '../src/setup/ultimate-control.js';
import { normalizeSetupSettings, saveSetupSettings, setupConfigDir } from '../src/setup/settings.js';

async function ownerFixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-ultimate-setup-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const previous = {
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    APPDATA: process.env.APPDATA,
    RWMCP_POLICY: process.env.RWMCP_POLICY,
    RWMCP_DEVICE_ID: process.env.RWMCP_DEVICE_ID
  };
  process.env.XDG_CONFIG_HOME = root;
  process.env.LOCALAPPDATA = root;
  process.env.APPDATA = root;
  process.env.RWMCP_POLICY = path.join(root, 'policy.yaml');
  process.env.RWMCP_DEVICE_ID = 'dev_windows_test';
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(workspace, { recursive: true });
  await saveSetupSettings(normalizeSetupSettings({
    mcpPort: 8683, controlPort: 8684, workspaceRoot: workspace,
    tunnelId: '', organizationId: '', cloudflaredManaged: false,
    httpScopes: ['workstation.read', 'workstation.write', 'workstation.execute', 'workstation.cross_node_transfer']
  }));
  await fs.writeFile(process.env.RWMCP_POLICY, YAML.stringify({
    version: 1, mode: 'workspace',
    workspaces: [{ id: 'stm32', root: workspace, readOnly: false }],
    filesystem: { maxReadBytes: 1048576, maxWriteBytes: 1048576 },
    process: { allowExecutables: ['git'], inheritEnv: ['PATH'], maxOutputBytes: 262144, maxRuntimeMs: 600000 },
    multiNode: {
      enabled: true, controllerPrincipalId: 'openai-tunnel', controllerPrincipalType: 'openai-secure-mcp-tunnel',
      grants: [{
        id: 'ssd-to-windows', enabled: true,
        sourceNodeId: 'dev_ssd', destinationNodeId: 'dev_windows_test',
        sourceWorkspace: 'projects', destinationWorkspace: 'stm32',
        sourcePathPrefixes: ['exports'], destinationBasePaths: ['incoming'],
        allowedExtensions: ['.zip'], maxBytes: 33554432, transports: ['relay']
      }]
    }
  }), 'utf8');
  const epochPath = path.join(setupConfigDir(), 'runtime', 'ultimate-runtime-epoch.json');
  await fs.mkdir(path.dirname(epochPath), { recursive: true });
  await fs.writeFile(epochPath, JSON.stringify({ epoch: 'runtime-A' }));
  return { root, epochPath };
}

const request = {
  durationMinutes: 240,
  scope: {
    operations: ['build', 'transfer'],
    workspaces: ['stm32'],
    profileIds: ['keil-release'],
    transferGrantIds: ['ssd-to-windows'],
    workSessionId: 'work-a'
  }
};

test('owner-only activation is bounded and cannot mutate underlying mode, scopes or unknown grants', async t => {
  const { root } = await ownerFixture(t);
  const initial = await readOwnerUltimateState(root);
  assert.equal(initial.active, false);
  assert.equal(initial.baseMode, 'workspace');
  assert.deepEqual(initial.availableWorkspaces, [{ id: 'stm32', name: 'stm32' }]);
  assert.deepEqual(initial.availableTransferGrants, [{ id: 'ssd-to-windows', sourceNodeId: 'dev_ssd', destinationNodeId: 'dev_windows_test' }]);
  assert.equal(initial.httpScopes.includes('workstation.execute'), true);
  const active = await activateOwnerUltimate(root, request, 'win32');
  assert.equal(active.active, true);
  assert.equal(active.remainingSeconds, 14400);
  assert.equal(active.baseMode, 'workspace');
  assert.equal(active.permanentFullAccessWarning, false);
  await assert.rejects(
    activateOwnerUltimate(root, { ...request, durationMinutes: 300 }, 'win32'),
    /duration|minutes|TTL/i
  );
  await revokeOwnerUltimate();
  const revoked = await readOwnerUltimateState(root);
  assert.equal(revoked.active, false);
  assert.equal(revoked.state, 'revoked');
  assert.deepEqual(revoked.recentEvents.map(event => event.action), ['activated', 'revoked']);
  await assert.rejects(
    activateOwnerUltimate(root, { ...request, scope: { ...request.scope, workspaces: ['unknown'] } }, 'win32'),
    /workspace|allowed|authorized/i
  );
  await assert.rejects(
    activateOwnerUltimate(root, { ...request, scope: { ...request.scope, transferGrantIds: ['missing-grant'] } }, 'win32'),
    /grant|allowed|authorized/i
  );
});

test('Control Center Ultimate API denies unauthenticated requests and supports revoke', async t => {
  await ownerFixture(t);
  const server = await startSetupServer({ repoRoot: process.cwd(), port: 23281, strictPort: false, openBrowser: false });
  t.after(() => server.close());
  const base = new URL(server.url).origin;
  const page = await (await fetch(base)).text();
  const token = page.match(/<meta name="rwmcp-setup-token" content="([A-Za-z0-9_-]+)">/)?.[1];
  assert.ok(token);
  const unauthorized = await fetch(base + '/api/ultimate');
  assert.equal(unauthorized.status, 403);
  const badOrigin = await fetch(base + '/api/ultimate', {
    headers: { 'x-rwmcp-setup-token': token, origin: 'https://untrusted.invalid' }
  });
  assert.equal(badOrigin.status, 403);
  const headers = { 'x-rwmcp-setup-token': token, 'content-type': 'application/json' };
  const status = await fetch(base + '/api/ultimate', { headers });
  assert.equal(status.status, 200);
  assert.equal((await status.json() as { active: boolean }).active, false);
  const activated = await fetch(base + '/api/ultimate/activate', {
    method: 'POST', headers, body: JSON.stringify(request)
  });
  assert.equal(activated.status, process.platform === 'win32' ? 200 : 400);
  if (process.platform === 'win32') assert.equal((await activated.json() as { active: boolean }).active, true);
  else assert.match((await activated.json() as { error: string }).error, /Windows-only/);
  const revoked = await fetch(base + '/api/ultimate', { method: 'DELETE', headers });
  assert.equal(revoked.status, 200);
  assert.equal((await (await fetch(base + '/api/ultimate', { headers })).json() as { active: boolean }).active, false);
});
