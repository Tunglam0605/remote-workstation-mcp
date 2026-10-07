import assert from 'node:assert/strict';
import test from 'node:test';
import { CAPABILITIES } from '../src/capabilities.js';
import {
  describeCapabilityToolExposure,
  describeOpenAiToolExposure,
  describeOpenAiToolPackCatalog,
  OPENAI_TOOL_PACK_CAPABILITY_IDS,
  OPENAI_TOOL_PACK_METADATA,
  OPENAI_TOOL_PACK_SELECTION_POLICY,
  parseOpenAiToolPacks,
  resolveOpenAiToolPacks,
  resolveOpenAiToolSurface,
  toolPackForCapability
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


test('tool-pack capability map points only at real capability descriptors', () => {
  const ids = new Set(CAPABILITIES.map(capability => capability.id));
  for (const capabilityIds of Object.values(OPENAI_TOOL_PACK_CAPABILITY_IDS)) {
    for (const capabilityId of capabilityIds) {
      assert.equal(ids.has(capabilityId), true, `unknown capability id ${capabilityId}`);
    }
  }
});

test('capability exposure distinguishes provider availability from OpenAI pack visibility', () => {
  assert.deepEqual(
    describeCapabilityToolExposure('engineering.canopen', 'openai-secure-mcp-tunnel', {}),
    { exposed: false, toolPack: 'canopen', reason: 'pack-not-selected', enablePack: 'canopen' }
  );
  assert.deepEqual(
    describeCapabilityToolExposure('engineering.canopen', 'openai-secure-mcp-tunnel', {
      RWMCP_OPENAI_TOOL_PACKS: 'canopen'
    }),
    { exposed: true, toolPack: 'canopen', reason: 'selected-pack' }
  );
  assert.deepEqual(
    describeCapabilityToolExposure('engineering.canopen', 'openai-secure-mcp-tunnel', {
      RWMCP_OPENAI_TOOL_SURFACE: 'full'
    }),
    { exposed: true, toolPack: 'canopen', reason: 'full' }
  );
  assert.deepEqual(
    describeCapabilityToolExposure('engineering.firmware', 'openai-secure-mcp-tunnel', {}),
    { exposed: true, toolPack: null, reason: 'baseline' }
  );
});

test('tool-pack catalog reports exact reusable capability groups and tool counts', () => {
  const catalog = describeOpenAiToolPackCatalog(
    CAPABILITIES,
    'openai-secure-mcp-tunnel',
    { RWMCP_OPENAI_TOOL_PACKS: 'canopen,industrial' }
  );

  assert.deepEqual(
    catalog.map(({ id, selected, exposed, reason, toolCount }) => ({ id, selected, exposed, reason, toolCount })),
    [
      { id: 'camera', selected: false, exposed: false, reason: 'not-selected', toolCount: 9 },
      { id: 'canopen', selected: true, exposed: true, reason: 'selected-pack', toolCount: 8 },
      { id: 'media', selected: false, exposed: false, reason: 'not-selected', toolCount: 24 },
      { id: 'industrial', selected: true, exposed: true, reason: 'selected-pack', toolCount: 14 }
    ]
  );
});

test('full surface exposes every pack without falsely marking packs as owner-selected', () => {
  const catalog = describeOpenAiToolPackCatalog(
    CAPABILITIES,
    'openai-secure-mcp-tunnel',
    { RWMCP_OPENAI_TOOL_SURFACE: 'full' }
  );

  assert.equal(catalog.every(entry => entry.exposed), true);
  assert.equal(catalog.every(entry => entry.selected === false), true);
  assert.equal(catalog.every(entry => entry.reason === 'full'), true);
});

test('capability to pack lookup stays deterministic', () => {
  assert.equal(toolPackForCapability('engineering.camera'), 'camera');
  assert.equal(toolPackForCapability('engineering.canopen'), 'canopen');
  assert.equal(toolPackForCapability('engineering.media'), 'media');
  assert.equal(toolPackForCapability('engineering.mqtt'), 'industrial');
  assert.equal(toolPackForCapability('engineering.modbus_rtu'), undefined);
  assert.equal(toolPackForCapability('engineering.firmware'), undefined);
});


test('every tool pack has reusable recommendation metadata and no automatic activation policy', () => {
  assert.deepEqual(Object.keys(OPENAI_TOOL_PACK_METADATA), ['camera', 'canopen', 'media', 'industrial']);
  for (const [id, metadata] of Object.entries(OPENAI_TOOL_PACK_METADATA)) {
    assert.ok(metadata.label.length > 0, `${id} label missing`);
    assert.ok(metadata.summary.length > 20, `${id} summary too short`);
    assert.ok(metadata.recommendedFor.length >= 2, `${id} recommendations too sparse`);
    assert.ok(metadata.notNeededFor.length >= 1, `${id} negative guidance missing`);
  }
  assert.deepEqual(OPENAI_TOOL_PACK_SELECTION_POLICY, {
    mode: 'recommend-only',
    automaticActivation: false,
    ownerControlled: true,
    restartRequired: true,
    baselineAlwaysAvailable: true,
    fullSurfaceExplicitOptIn: true
  });
});

test('pack catalog carries recommendation metadata together with exposure state', () => {
  const [camera, canopen, media, industrial] = describeOpenAiToolPackCatalog(
    CAPABILITIES,
    'openai-secure-mcp-tunnel',
    { RWMCP_OPENAI_TOOL_PACKS: 'canopen' }
  );
  assert.equal(camera.label, 'Camera');
  assert.match(canopen.summary, /CANopen/);
  assert.equal(canopen.selected, true);
  assert.equal(canopen.exposed, true);
  assert.ok(canopen.recommendedFor.some(item => /EDS|DCF/.test(item)));
  assert.ok(media.recommendedFor.some(item => /Remotion/.test(item)));
  assert.ok(industrial.recommendedFor.some(item => /OPC UA/.test(item)));
  assert.ok(industrial.notNeededFor.some(item => /Modbus RTU/.test(item)));
});
