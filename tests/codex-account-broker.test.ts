import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CODEX_COCKPIT_API_KEY_ENV,
  CodexAccountBroker
} from '../src/workers/codex-account-broker.js';

async function tempRoot(t: test.TestContext): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-codex-broker-'));
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function writeJson(root: string, name: string, value: unknown): Promise<void> {
  await fs.writeFile(path.join(root, name), JSON.stringify(value, null, 2), 'utf8');
}

async function listen(t: test.TestContext, apiKey: string): Promise<number> {
  const server = http.createServer((req, res) => {
    if (req.url !== '/v1/models') {
      res.writeHead(404).end();
      return;
    }
    if (req.headers.authorization !== `Bearer ${apiKey}`) {
      res.writeHead(401).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"data":[]}');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  t.after(async () => await new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not expose a TCP port');
  return address.port;
}

test('Codex account broker exposes masked metadata and never returns Cockpit secrets', async t => {
  const root = await tempRoot(t);
  const secret = 'super-secret-local-pool-key';
  await writeJson(root, 'codex_accounts.json', {
    accounts: [
      { id: 'codex-a', email: 'tunglam652004@gmail.com', plan_type: 'plus', last_used: 123 },
      { id: 'codex-b', email: 'nhbinh.uneti@gmail.com', plan_type: 'plus', last_used: 456 }
    ]
  });
  await writeJson(root, 'codex_local_access.json', {
    enabled: false,
    port: 56096,
    apiKey: secret,
    accessScope: 'localhost',
    clientBaseUrlHost: 'localhost',
    gatewayMode: 'sidecar',
    routingStrategy: 'auto',
    sessionAffinity: true,
    disableCooling: false,
    accountIds: ['codex-a', 'codex-b']
  });

  const broker = new CodexAccountBroker(
    { enabled: true, mode: 'cockpit-api-pool' },
    { dataRoot: root }
  );
  const status = await broker.status();

  assert.equal(status.detected, true);
  assert.equal(status.effectiveBackend, 'blocked');
  assert.equal(status.pool.enabled, false);
  assert.equal(status.pool.apiKeyConfigured, true);
  assert.deepEqual(status.accounts.map(a => a.emailMasked), [
    'tun***@gmail.com',
    'nhb***@gmail.com'
  ]);
  assert.deepEqual(status.accounts.map(a => a.poolMember), [true, true]);
  const serialized = JSON.stringify(status);
  assert.doesNotMatch(serialized, /super-secret-local-pool-key/);
  assert.doesNotMatch(serialized, /access_token|refresh_token|ciphertext/i);
});

test('Codex account broker requires explicit healthy loopback sidecar pool before activation', async t => {
  const root = await tempRoot(t);
  const apiKey = 'pool-key-for-test-only';
  const port = await listen(t, apiKey);
  await writeJson(root, 'codex_accounts.json', {
    accounts: [{ id: 'codex-a', email: 'a@example.com', plan_type: 'plus' }]
  });
  await writeJson(root, 'codex_local_access.json', {
    enabled: true,
    port,
    apiKey,
    accessScope: 'localhost',
    clientBaseUrlHost: 'localhost',
    gatewayMode: 'sidecar',
    routingStrategy: 'auto',
    sessionAffinity: true,
    disableCooling: false,
    accountIds: ['codex-a']
  });

  const broker = new CodexAccountBroker(
    { enabled: true, mode: 'cockpit-api-pool' },
    { dataRoot: root }
  );
  const status = await broker.status({ probe: true });

  assert.equal(status.effectiveBackend, 'cockpit-api-pool');
  assert.equal(status.pool.healthy, true);
  assert.match(status.pool.detail, /HTTP 200/);

  const launch = await broker.poolLaunch();
  assert.equal(launch.env[CODEX_COCKPIT_API_KEY_ENV], apiKey);
  assert.equal(launch.env.NO_PROXY, '127.0.0.1,localhost,::1');
  assert.ok(launch.args.includes('model_provider="rwmcp_cockpit_pool"'));
  assert.ok(launch.args.some(arg => arg.includes('base_url="http://127.0.0.1:')));
  assert.ok(launch.args.some(arg => arg.includes(`env_key="${CODEX_COCKPIT_API_KEY_ENV}"`)));
  assert.ok(!launch.args.some(arg => arg.includes(apiKey)), 'secret must never appear in argv');
});

test('Codex account broker rejects non-loopback, empty-pool and cooling-disabled configurations', async t => {
  const root = await tempRoot(t);
  await writeJson(root, 'codex_accounts.json', {
    accounts: [{ id: 'codex-a', email: 'a@example.com', plan_type: 'plus' }]
  });
  await writeJson(root, 'codex_local_access.json', {
    enabled: true,
    port: 56096,
    apiKey: 'secret',
    accessScope: 'lan',
    clientBaseUrlHost: '0.0.0.0',
    gatewayMode: 'sidecar',
    routingStrategy: 'auto',
    sessionAffinity: true,
    disableCooling: false,
    accountIds: ['codex-a']
  });
  let broker = new CodexAccountBroker({ enabled: true, mode: 'cockpit-api-pool' }, { dataRoot: root });
  let status = await broker.status();
  assert.equal(status.effectiveBackend, 'blocked');
  assert.match(status.pool.detail, /loopback-only/);

  await writeJson(root, 'codex_local_access.json', {
    enabled: true,
    port: 56096,
    apiKey: 'secret',
    accessScope: 'localhost',
    clientBaseUrlHost: 'localhost',
    gatewayMode: 'sidecar',
    routingStrategy: 'auto',
    sessionAffinity: true,
    disableCooling: false,
    accountIds: []
  });
  broker = new CodexAccountBroker({ enabled: true, mode: 'cockpit-api-pool' }, { dataRoot: root });
  status = await broker.status();
  assert.match(status.pool.detail, /pool is empty/);

  await writeJson(root, 'codex_local_access.json', {
    enabled: true,
    port: 56096,
    apiKey: 'secret',
    accessScope: 'localhost',
    clientBaseUrlHost: 'localhost',
    gatewayMode: 'sidecar',
    routingStrategy: 'auto',
    sessionAffinity: true,
    disableCooling: true,
    accountIds: ['codex-a']
  });
  broker = new CodexAccountBroker({ enabled: true, mode: 'cockpit-api-pool' }, { dataRoot: root });
  status = await broker.status();
  assert.match(status.pool.detail, /cooling must be enabled/);
});

test('native broker mode never requires Cockpit pool health', async t => {
  const root = await tempRoot(t);
  await writeJson(root, 'codex_local_access.json', {
    enabled: false,
    port: 56096,
    apiKey: 'secret'
  });
  const broker = new CodexAccountBroker({ enabled: false, mode: 'native' }, { dataRoot: root });
  const status = await broker.status();
  assert.equal(status.requestedMode, 'native');
  assert.equal(status.effectiveBackend, 'native');
});
