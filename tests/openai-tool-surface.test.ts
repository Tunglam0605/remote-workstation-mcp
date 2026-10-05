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
  'domain.modbus-tcp'
]);

test('v0.67 expansion families stay behind the expanded MCP tool surface', () => {
  const extensions = createBuiltinExtensionRegistry().list();
  const byId = new Map(extensions.map(extension => [extension.id, extension]));

  for (const id of expandedV067) {
    const extension = byId.get(id);
    assert.ok(extension, `missing built-in extension ${id}`);
    assert.equal(extension.exposure, 'expanded', `${id} must not inflate the default OpenAI tool surface`);
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
