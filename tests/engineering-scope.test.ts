import assert from 'node:assert/strict';
import test from 'node:test';
import { CAPABILITIES } from '../src/capabilities.js';
import { requiredScopeForTool } from '../src/security/request-principal.js';

test('every advertised engineering/tool capability has authenticated scope classification', () => {
  const advertised = CAPABILITIES.flatMap(capability => capability.tools);
  const missing = advertised.filter(tool => requiredScopeForTool(tool) === undefined);
  assert.deepEqual(missing, []);
});
