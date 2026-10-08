import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveKicadPlacementHints } from '../src/adapters/engineering/kicad-placement-policy.js';
import type { KicadElectronicDesignIntent } from '../src/adapters/engineering/kicad-design-intent.js';

function intent(): KicadElectronicDesignIntent {
  return {
    schemaVersion: 1,
    name: 'Robot controller',
    rails: [
      { name: 'GND', nominalVoltageV: 0, source: 'derived', isGround: true },
      { name: '3V3', nominalVoltageV: 3.3, source: 'regulator' },
      { name: '24V', nominalVoltageV: 24, source: 'external' }
    ],
    devices: [
      { reference: 'U1', role: 'mcu', partNumber: 'STM32F407VGT6', package: 'LQFP100' },
      { reference: 'U2', role: 'transceiver', partNumber: 'TJA1051' },
      { reference: 'J1', role: 'connector' },
      { reference: 'J2', role: 'connector' },
      { reference: 'U3', role: 'power', partNumber: 'LM2596' },
      { reference: 'U4', role: 'memory', partNumber: 'W25Q64' }
    ],
    interfaces: [
      { id: 'CAN_EXT', kind: 'can', signals: ['CAN_H', 'CAN_L'], deviceRefs: ['U2', 'J1'], external: true },
      { id: 'DEBUG', kind: 'debug', signals: ['SWDIO', 'SWCLK'], deviceRefs: ['U1', 'J2'], external: true }
    ],
    functionalBlocks: [
      { id: 'CONTROL', deviceRefs: ['U1', 'U4'], keepTogether: true },
      { id: 'CAN_IO', deviceRefs: ['U2', 'J1'], preferredRegion: 'connector-edge', keepTogether: true },
      { id: 'POWER_IN', deviceRefs: ['U3'], preferredRegion: 'power-entry', keepTogether: true }
    ]
  };
}

test('placement policy maps design roles onto the existing semantic placement engine', () => {
  const result = deriveKicadPlacementHints(intent());
  assert.equal(result.ready, true);
  assert.equal(result.assumptions.pinAwarePadGeometryPreserved, true);
  assert.equal(result.hints.find(item => item.reference === 'U1')?.role, 'mcu');
  assert.equal(result.hints.find(item => item.reference === 'U2')?.role, 'transceiver');
  assert.equal(result.hints.find(item => item.reference === 'J1')?.role, 'connector');
  assert.equal(result.hints.find(item => item.reference === 'J2')?.role, 'debug');
  assert.equal(result.hints.find(item => item.reference === 'U3')?.role, 'power');
});

test('functional blocks produce anchors and connector edge hints without exact-coordinate synthesis', () => {
  const result = deriveKicadPlacementHints(intent());
  assert.equal(result.hints.find(item => item.reference === 'U4')?.anchorRef, 'U1');
  assert.equal(result.hints.find(item => item.reference === 'U2')?.anchorRef, 'J1');
  assert.equal(result.hints.find(item => item.reference === 'J1')?.edge, 'right');
  assert.equal(result.hints.find(item => item.reference === 'U3')?.edge, undefined);
  assert.ok(result.findings.some(item => item.code === 'placement-functional-block-anchor' && item.subject === 'CONTROL'));
});

test('interface topology anchors transceivers to connectors when no functional-block anchor exists', () => {
  const value = intent();
  value.functionalBlocks = [{ id: 'CONTROL', deviceRefs: ['U1', 'U4'], keepTogether: true }];
  const result = deriveKicadPlacementHints(value);
  assert.equal(result.hints.find(item => item.reference === 'U2')?.anchorRef, 'J1');
});

test('unknown block devices fail the placement-policy readiness gate', () => {
  const value = intent();
  value.functionalBlocks!.push({ id: 'BAD', deviceRefs: ['U404'], keepTogether: true });
  const result = deriveKicadPlacementHints(value);
  assert.equal(result.ready, false);
  assert.ok(result.findings.some(item => item.code === 'placement-block-device-missing'));
});

test('multi-block membership is review-only and deterministic', () => {
  const value = intent();
  value.functionalBlocks!.push({ id: 'SECOND', deviceRefs: ['U4', 'J1'], keepTogether: true });
  const result = deriveKicadPlacementHints(value);
  assert.equal(result.ready, true);
  assert.ok(result.findings.some(item => item.code === 'placement-device-multi-block' && item.subject === 'U4'));
});
