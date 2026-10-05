import assert from 'node:assert/strict';
import test from 'node:test';
import {
  describeOpenAiToolExposure,
  parseOpenAiToolPacks,
  resolveOpenAiToolPacks,
  resolveOpenAiToolSurface
} from '../src/tool-exposure.js';

test('OpenAI tool packs are bounded, canonical and fail closed on unknown values', () => {
  assert.deepEqual(parseOpenAiToolPacks(undefined), []);
  assert.deepEqual(parseOpenAiToolPacks(''), []);
  assert.deepEqual(
    parseOpenAiToolPacks('industrial,camera,unknown,camera, media '),
    ['camera', 'media', 'industrial']
  );
});

test('OpenAI tunnel defaults to baseline and selected packs do not imply full surface', () => {
  const env = { RWMCP_OPENAI_TOOL_PACKS: 'canopen,industrial' };
  assert.equal(resolveOpenAiToolSurface('openai-secure-mcp-tunnel', env), 'baseline');
  assert.deepEqual(resolveOpenAiToolPacks('openai-secure-mcp-tunnel', env), ['canopen', 'industrial']);
  assert.deepEqual(describeOpenAiToolExposure('openai-secure-mcp-tunnel', env), {
    mode: 'baseline-plus-packs',
    packs: ['canopen', 'industrial']
  });
});

test('full surface remains an explicit opt-in and non-OpenAI clients keep full behavior', () => {
  assert.deepEqual(
    describeOpenAiToolExposure('openai-secure-mcp-tunnel', {
      RWMCP_OPENAI_TOOL_SURFACE: 'full',
      RWMCP_OPENAI_TOOL_PACKS: 'camera'
    }),
    { mode: 'full', packs: [] }
  );
  assert.equal(resolveOpenAiToolSurface('managed-http', {}), 'full');
  assert.deepEqual(resolveOpenAiToolPacks('managed-http', { RWMCP_OPENAI_TOOL_PACKS: 'camera' }), []);
});
