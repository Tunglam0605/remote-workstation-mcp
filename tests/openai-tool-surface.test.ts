import assert from 'node:assert/strict';
import test from 'node:test';
import { createBuiltinExtensionRegistry } from '../src/extensions/builtin.js';

const expandedV067 = new Set([
  'domain.camera',
  'domain.canopen',
  'domain.media',
  'domain.mqtt',
  'domain.industrial-profiles',
  'domain.opcua',
  'domain.modbus-tcp',
  'app.social-publishing'
]);

const expectedPacks = new Map([
  ['domain.camera', 'camera'],
  ['domain.canopen', 'canopen'],
  ['domain.media', 'media'],
  ['domain.mqtt', 'industrial'],
  ['domain.industrial-profiles', 'industrial'],
  ['domain.opcua', 'industrial'],
  ['domain.modbus-tcp', 'industrial'],
  ['app.social-publishing', 'social']
]);

test('v0.67 expansion families stay behind the expanded MCP tool surface', () => {
  const extensions = createBuiltinExtensionRegistry().list();
  const byId = new Map(extensions.map(extension => [extension.id, extension]));

  for (const id of expandedV067) {
    const extension = byId.get(id);
    assert.ok(extension, `missing built-in extension ${id}`);
    assert.equal(extension.exposure, 'expanded', `${id} must not inflate the default OpenAI tool surface`);
    assert.equal(extension.toolPack, expectedPacks.get(id), `${id} must declare its canonical OpenAI tool pack`);
  }

  for (const extension of extensions) {
    if (!expandedV067.has(extension.id)) {
      assert.notEqual(extension.exposure, 'expanded', `baseline extension ${extension.id} was unexpectedly filtered`);
    }
  }
});

test('v0.67 compatibility filter covers exactly the newly added expansion families', () => {
  const filtered = createBuiltinExtensionRegistry()
    .list()
    .filter(extension => extension.exposure === 'expanded')
    .map(extension => extension.id)
    .sort();

  assert.deepEqual(filtered, [...expandedV067].sort());
});


test('every expanded built-in extension is assigned to a known reusable pack', () => {
  const expanded = createBuiltinExtensionRegistry().list().filter(extension => extension.exposure === 'expanded');
  assert.deepEqual(
    expanded.map(extension => [extension.id, extension.toolPack]),
    [...expectedPacks.entries()]
  );
});
