import assert from 'node:assert/strict';
import test from 'node:test';
import { ExtensionRegistry, resolveExtensionToolSurface } from '../src/extensions/registry.js';

const fakeServer = {} as never;
const fakeContext = { actor: { clientType: 'test-client' } } as never;

test('extension registry preserves registration order', () => {
  const seen: string[] = [];
  const registry = new ExtensionRegistry()
    .add({ id: 'a', version: 1, kind: 'app', register: () => { seen.push('a'); } })
    .add({ id: 'b', version: 1, kind: 'domain', register: () => { seen.push('b'); } });

  const result = registry.registerAll(fakeServer, fakeContext, 'linux');
  assert.deepEqual(seen, ['a', 'b']);
  assert.deepEqual(result.map(item => item.registered), [true, true]);
});

test('extension registry skips unsupported platforms without invoking registration', () => {
  let called = false;
  const registry = new ExtensionRegistry().add({
    id: 'windows-only',
    version: 1,
    kind: 'productivity',
    platforms: ['win32'],
    register: () => { called = true; }
  });

  const [result] = registry.registerAll(fakeServer, fakeContext, 'linux');
  assert.equal(called, false);
  assert.deepEqual(result, { id: 'windows-only', registered: false, reason: 'unsupported-platform' });
});

test('baseline tool surface filters expanded extensions without deleting them from the registry', () => {
  const seen: string[] = [];
  const registry = new ExtensionRegistry()
    .add({ id: 'baseline', version: 1, kind: 'domain', register: () => { seen.push('baseline'); } })
    .add({ id: 'expanded', version: 1, kind: 'domain', exposure: 'expanded', register: () => { seen.push('expanded'); } });

  const result = registry.registerAll(fakeServer, fakeContext, 'win32', 'baseline');
  assert.deepEqual(seen, ['baseline']);
  assert.deepEqual(result, [
    { id: 'baseline', registered: true },
    { id: 'expanded', registered: false, reason: 'client-surface-filtered' }
  ]);
  assert.deepEqual(registry.list().map(extension => extension.id), ['baseline', 'expanded']);
});

test('full tool surface registers expanded extensions', () => {
  const seen: string[] = [];
  const registry = new ExtensionRegistry().add({
    id: 'expanded',
    version: 1,
    kind: 'domain',
    exposure: 'expanded',
    register: () => { seen.push('expanded'); }
  });

  const [result] = registry.registerAll(fakeServer, fakeContext, 'win32', 'full');
  assert.deepEqual(seen, ['expanded']);
  assert.deepEqual(result, { id: 'expanded', registered: true });
});

test('OpenAI Secure MCP Tunnel defaults to baseline exposure and permits explicit full opt-in', () => {
  assert.equal(resolveExtensionToolSurface('openai-secure-mcp-tunnel', {}), 'baseline');
  assert.equal(resolveExtensionToolSurface('chatgpt', {}), 'baseline');
  assert.equal(resolveExtensionToolSurface('openai-secure-mcp-tunnel', { RWMCP_OPENAI_TOOL_SURFACE: 'full' }), 'full');
  assert.equal(resolveExtensionToolSurface('chatgpt', { RWMCP_OPENAI_TOOL_SURFACE: 'full' }), 'full');
  assert.equal(resolveExtensionToolSurface('managed-http', {}), 'full');
});

test('extension initialization runs once per AppContext across fresh registry instances', () => {
  const lifecycle: string[] = [];
  const createRegistry = () => new ExtensionRegistry().add({
    id: 'stateful-lifecycle',
    version: 1,
    kind: 'domain',
    initialize: () => { lifecycle.push('initialize'); },
    register: () => { lifecycle.push('register'); }
  });

  createRegistry().registerAll(fakeServer, fakeContext, 'linux', 'full');
  createRegistry().registerAll(fakeServer, fakeContext, 'linux', 'full');

  assert.deepEqual(lifecycle, ['initialize', 'register', 'register']);
});

test('filtered extensions are not initialized until they are actually exposed', () => {
  const lifecycle: string[] = [];
  const registry = new ExtensionRegistry().add({
    id: 'deferred-expanded',
    version: 1,
    kind: 'domain',
    exposure: 'expanded',
    initialize: () => { lifecycle.push('initialize'); },
    register: () => { lifecycle.push('register'); }
  });

  registry.registerAll(fakeServer, fakeContext, 'win32', 'baseline');
  assert.deepEqual(lifecycle, []);

  registry.registerAll(fakeServer, fakeContext, 'win32', 'full');
  registry.registerAll(fakeServer, fakeContext, 'win32', 'full');
  assert.deepEqual(lifecycle, ['initialize', 'register', 'register']);
});

test('extension registry rejects duplicate ids and invalid versions', () => {
  const registry = new ExtensionRegistry().add({
    id: 'same',
    version: 1,
    kind: 'app',
    register: () => undefined
  });

  assert.throws(() => registry.add({
    id: 'same',
    version: 1,
    kind: 'app',
    register: () => undefined
  }), /Duplicate extension id/);

  assert.throws(() => new ExtensionRegistry().add({
    id: 'bad-version',
    version: 0,
    kind: 'app',
    register: () => undefined
  }), /invalid version/);
});
