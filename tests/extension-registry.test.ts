import assert from 'node:assert/strict';
import test from 'node:test';
import { ExtensionRegistry } from '../src/extensions/registry.js';

const fakeServer = {} as never;
const fakeContext = {} as never;

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
