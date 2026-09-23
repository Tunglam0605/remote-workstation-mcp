import assert from 'node:assert/strict';
import test from 'node:test';
import { createApi } from '../assets/moonlight/api.js';
import { createStore } from '../assets/moonlight/store.js';
import { deriveActivities, deriveCards, deriveMetrics, deriveNotifications } from '../assets/moonlight/model.js';

const resource = (data: unknown, error: Error | null = null) => ({ data: error ? null : data, error, loading: false, loadedAt: error ? null : 1 });
const emptyResources = () => Object.fromEntries(['status', 'runtime', 'execution', 'antigravity', 'pairing', 'multiNode', 'permissions', 'updates', 'admin', 'console'].map((key) => [key, resource(null)]));

test('api keeps the setup token in a same-origin header and reports response errors', async () => {
  let received: Request | undefined;
  const api = createApi('ephemeral-token', {
    fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
      received = new Request(input, init);
      return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403, headers: { 'content-type': 'application/json' } });
    }
  });

  await assert.rejects(api.request('/api/status'), (error: Error & { status?: number }) => error.status === 403 && error.message === 'forbidden');
  assert.equal(received?.url, 'http://localhost/api/status');
  assert.equal(received?.headers.get('x-rwmcp-setup-token'), 'ephemeral-token');
  assert.equal(received?.headers.get('cache-control'), 'no-store');
  await assert.rejects(api.request('https://example.test/api/status'), /same-origin API path/);
});

test('store removes stale resource data after a failed refresh', async () => {
  let shouldFail = false;
  const api = {
    request: async (path: string) => {
      if (shouldFail && path === '/api/runtime/status') throw new Error('runtime unavailable');
      return path === '/api/runtime/status' ? { running: true, mcpHealthy: true, tunnelReady: true } : {};
    }
  };
  const store = createStore(api);
  await store.refresh(['runtime']);
  assert.equal(store.getState().runtime.data?.running, true);
  shouldFail = true;
  await store.refresh(['runtime']);
  assert.equal(store.getState().runtime.data, null);
  assert.equal(store.getState().runtime.error?.message, 'runtime unavailable');
});

test('model uses backend facts for the host, paired inventory, providers and health without padding cards', () => {
  const resources = emptyResources();
  resources.status = resource({ identity: { name: 'Lab PC' }, platform: 'win32', nodeVersion: 'v22.1.0' });
  resources.runtime = resource({ running: true, mcpHealthy: true, tunnelReady: true, connectionState: 'ONLINE' });
  resources.execution = resource({ settings: { antigravityEnabled: true }, codex: { installed: true, authenticated: true, version: '1.2.3' }, status: { codexEnabled: true, codexTasksToday: 2, codexTasksThisSession: 1, maxCodexTasksPerDay: 10, maxCodexTasksPerSession: 4 } });
  resources.antigravity = resource({ installed: true, authenticated: true, available: true, version: '2.0' });
  resources.pairing = resource({ devices: [{ id: 'node-1', name: 'Build Node', platform: 'linux', pairedAt: '2026-09-01T00:00:00Z', lastSeenAt: '2026-09-02T00:00:00Z' }], pending: [], bootstrapHosts: [] });
  const cards = deriveCards(resources);
  assert.deepEqual(cards.map((card) => card.id), ['local-host', 'device:node-1', 'codex', 'antigravity', 'health']);
  assert.equal(cards[0].name, 'Lab PC');
  assert.equal(cards[1].status, 'Unavailable');
  assert.equal(cards[1].specs.find((spec) => spec.label === 'Last seen')?.value, '2026-09-02T00:00:00Z');
  assert.equal(cards[0].specs.find((spec) => spec.label === 'Tunnel')?.value, 'Ready');
  assert.equal(cards.find((card) => card.id === 'codex')?.status, 'Online');
  assert.equal(cards.find((card) => card.id === 'antigravity')?.status, 'Online');
  assert.equal(cards.some((card) => card.specs.some((spec) => /RAM|CPU|Latency/i.test(spec.label))), false);
});

test('model distinguishes unavailable data from false backend state and derives only backed notifications', () => {
  const resources = emptyResources();
  resources.runtime = resource(null, new Error('network failed'));
  resources.execution = resource({ codex: { installed: true, authenticated: true }, status: { fallbackActive: true, fallbackReason: 'limit', codexTasksToday: 2, codexTasksThisSession: 1, maxCodexTasksPerDay: 10, maxCodexTasksPerSession: 4 } });
  resources.updates = resource({ updateAvailable: true, installedVersion: '0.30.0', latestVersion: '0.32.4' });
  resources.admin = resource({ requests: [{ id: 'a1', state: 'pending', createdAt: '2026-09-02T00:00:00Z', program: 'installer' }] });
  const cards = deriveCards(resources);
  assert.equal(cards.find((card) => card.id === 'health')?.status, 'Unavailable');
  assert.equal(cards.find((card) => card.id === 'local-host')?.specs.find((spec) => spec.label === 'Runtime')?.value, '—');
  assert.equal(cards.find((card) => card.id === 'local-host')?.specs.find((spec) => spec.label === 'Tunnel')?.value, '—');
  assert.equal(cards.find((card) => card.id === 'health')?.specs.find((spec) => spec.label === 'MCP')?.value, '—');
  assert.deepEqual(deriveNotifications(resources, new Set(['update-available'])).map(({ id, read }) => ({ id, read })), [
    { id: 'runtime-unavailable', read: false },
    { id: 'codex-fallback', read: false },
    { id: 'update-available', read: true },
    { id: 'admin:a1', read: false }
  ]);
  assert.deepEqual(deriveMetrics(resources).map(({ label, value }) => ({ label, value })), [
    { label: 'Codex tasks today', value: '2' },
    { label: 'Codex tasks this session', value: '1' },
    { label: 'Daily limit', value: '10' },
    { label: 'Session limit', value: '4' }
  ]);
  assert.deepEqual(deriveActivities(resources), [{ id: 'admin:a1:created', type: 'admin', state: 'pending', timestamp: '2026-09-02T00:00:00Z', description: 'Admin request pending' }]);
});

test('model treats backend probe fallbacks as unavailable and distinguishes provider readiness from policy enablement', () => {
  const resources = emptyResources();
  resources.status = resource({ identity: { name: 'Lab PC' }, platform: 'win32' });
  resources.runtime = resource({ running: false, mcpHealthy: false, tunnelReady: false, connectionState: 'OFFLINE', error: 'runtime-control-unavailable' });
  resources.execution = resource({
    settings: { antigravityEnabled: false },
    status: { codexEnabled: false },
    codex: { installed: true, authenticated: true, version: '1.2.3' }
  });
  resources.antigravity = resource({ installed: true, authenticated: true, available: true, version: '2.0' });
  resources.pairing = resource({ devices: [
    { id: 'active', name: 'Active', platform: 'linux', pairedAt: '2026-09-01T00:00:00Z' },
    { id: 'revoked', name: 'Revoked', platform: 'linux', pairedAt: '2026-09-01T00:00:00Z', revokedAt: '2026-09-02T00:00:00Z' }
  ] });
  const cards = deriveCards(resources);
  assert.equal(cards.find((card) => card.id === 'health')?.status, 'Unavailable');
  assert.equal(cards.find((card) => card.id === 'local-host')?.specs.find((spec) => spec.label === 'Runtime')?.value, '—');
  assert.equal(cards.find((card) => card.id === 'local-host')?.specs.find((spec) => spec.label === 'Tunnel')?.value, '—');
  assert.equal(cards.find((card) => card.id === 'health')?.specs.find((spec) => spec.label === 'MCP')?.value, '—');
  assert.equal(cards.find((card) => card.id === 'health')?.specs.find((spec) => spec.label === 'Connection')?.value, '—');
  assert.equal(cards.find((card) => card.id === 'codex')?.status, 'Disabled');
  assert.equal(cards.find((card) => card.id === 'antigravity')?.status, 'Disabled');
  assert.equal(cards.some((card) => card.id === 'device:active'), true);
  assert.equal(cards.some((card) => card.id === 'device:revoked'), false);
});

test('zero Codex task limits are unlimited rather than zero available quota', () => {
  const resources = emptyResources();
  resources.execution = resource({ status: { codexTasksToday: 0, codexTasksThisSession: 0, maxCodexTasksPerDay: 0, maxCodexTasksPerSession: 0 } });
  assert.deepEqual(deriveMetrics(resources).map(({ label, value }) => ({ label, value })), [
    { label: 'Codex tasks today', value: '0' },
    { label: 'Codex tasks this session', value: '0' },
    { label: 'Daily limit', value: 'Unlimited' },
    { label: 'Session limit', value: 'Unlimited' }
  ]);
});

test('missing health and provider enablement are unavailable rather than inferred from other fields', () => {
  const resources = emptyResources();
  resources.status = resource({ identity: { name: 'Lab PC' } });
  resources.runtime = resource({ running: true, tunnelReady: true });
  resources.execution = resource({ codex: { installed: true, authenticated: true } });
  resources.antigravity = resource({ installed: true, authenticated: true, available: true });
  const cards = deriveCards(resources);
  assert.equal(cards.find((card) => card.id === 'local-host')?.specs.find((spec) => spec.label === 'Runtime')?.value, 'Running');
  assert.equal(cards.find((card) => card.id === 'local-host')?.specs.find((spec) => spec.label === 'Tunnel')?.value, 'Ready');
  assert.equal(cards.find((card) => card.id === 'health')?.status, 'Unavailable');
  assert.equal(cards.find((card) => card.id === 'health')?.specs.find((spec) => spec.label === 'MCP')?.value, '—');
  assert.equal(cards.find((card) => card.id === 'codex')?.status, 'Unavailable');
  assert.equal(cards.find((card) => card.id === 'antigravity')?.status, 'Unavailable');
});

test('activities retain every backend timestamped admin transition and updater transaction', () => {
  const resources = emptyResources();
  resources.admin = resource({ requests: [{
    id: 'a1', state: 'succeeded', program: 'installer', createdAt: '2026-09-01T00:00:00Z',
    approvedAt: '2026-09-01T00:01:00Z', startedAt: '2026-09-01T00:02:00Z', result: { finishedAt: '2026-09-01T00:03:00Z' }
  }] });
  resources.updates = resource({ transaction: { state: 'RUNNING', updatedAt: '2026-09-01T00:04:00Z' } });
  assert.deepEqual(deriveActivities(resources).map(({ id, timestamp }) => ({ id, timestamp })), [
    { id: 'update:RUNNING:2026-09-01T00:04:00Z', timestamp: '2026-09-01T00:04:00Z' },
    { id: 'admin:a1:succeeded', timestamp: '2026-09-01T00:03:00Z' },
    { id: 'admin:a1:started', timestamp: '2026-09-01T00:02:00Z' },
    { id: 'admin:a1:approved', timestamp: '2026-09-01T00:01:00Z' },
    { id: 'admin:a1:created', timestamp: '2026-09-01T00:00:00Z' }
  ]);
});
