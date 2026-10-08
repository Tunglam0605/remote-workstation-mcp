import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveKicadRoutingPolicy } from '../src/adapters/engineering/kicad-routing-policy.js';
import type { KicadElectronicDesignIntent } from '../src/adapters/engineering/kicad-design-intent.js';

function intent(): KicadElectronicDesignIntent {
  return {
    schemaVersion: 1,
    name: 'Robot controller',
    board: { copperLayers: 4, minimumClearanceMm: 0.2 },
    rails: [
      { name: 'GND', nominalVoltageV: 0, source: 'derived', isGround: true },
      { name: '3V3', nominalVoltageV: 3.3, currentBudgetA: 0.4, source: 'regulator' },
      { name: 'VMOTOR', nominalVoltageV: 24, currentBudgetA: 2.5, source: 'external' }
    ],
    devices: [{
      reference: 'U1', role: 'mcu', partNumber: 'STM32F407VGT6', package: 'LQFP100',
      supplyRails: ['3V3', 'GND'],
      clocks: [{ name: 'HSE', frequencyHz: 8_000_000, source: 'crystal', critical: true }]
    }],
    interfaces: [
      { id: 'CAN_EXT', kind: 'can', signals: ['CAN_H', 'CAN_L'], external: true, terminationRequired: true },
      { id: 'USB_FS', kind: 'usb', signals: ['USB_DP', 'USB_DM'], targetImpedanceOhm: 90, external: true },
      { id: 'ADC_IN', kind: 'analog', signals: ['ADC1_IN0'], external: true }
    ]
  };
}

test('routing policy derives power, interface and clock priorities from design intent', () => {
  const result = deriveKicadRoutingPolicy(intent());
  assert.equal(result.ready, true);
  assert.equal(result.assumptions.controlledImpedanceSynthesized, false);
  assert.equal(result.assumptions.ampacityCertified, false);
  assert.ok(result.netClasses.some(item => item.name === 'POWER_3V3' && item.trackWidthMm === 0.4));
  assert.ok(result.netClasses.some(item => item.name === 'POWER_VMOTOR' && item.trackWidthMm === 1.5));
  assert.ok(result.routeStyles.some(item => item.netName === 'HSE' && item.priority === 700));
  assert.ok(result.routeStyles.some(item => item.netName === 'USB_DP' && item.priority === 650));
  assert.ok(result.routeStyles.some(item => item.netName === 'ADC1_IN0' && item.priority === 600));
  assert.ok(result.findings.some(item => item.code === 'power-ampacity-review-required' && item.subject === 'VMOTOR'));
});

test('controlled impedance remains an evidence gate rather than guessed diff-pair width/gap', () => {
  const result = deriveKicadRoutingPolicy(intent());
  const usb = result.differentialPairs.find(item => item.interfaceId === 'USB_FS');
  assert.equal(usb?.targetImpedanceOhm, 90);
  assert.equal(usb?.controlledImpedanceEvidenceRequired, true);
  const usbClass = result.netClasses.find(item => item.name === 'USB_USB_FS');
  assert.equal(usbClass?.diffPairWidthMm, undefined);
  assert.equal(usbClass?.diffPairGapMm, undefined);
  assert.ok(result.findings.some(item => item.code === 'controlled-impedance-evidence-required'));
});

test('CAN pair gets coherent-routing review without inventing a controlled-impedance target', () => {
  const result = deriveKicadRoutingPolicy(intent());
  const can = result.differentialPairs.find(item => item.interfaceId === 'CAN_EXT');
  assert.deepEqual(can?.nets, ['CAN_H', 'CAN_L']);
  assert.equal(can?.targetImpedanceOhm, undefined);
  assert.equal(can?.controlledImpedanceEvidenceRequired, false);
});

test('high-speed two-layer designs are explicitly flagged for return-path review', () => {
  const value = intent();
  value.board!.copperLayers = 2;
  const result = deriveKicadRoutingPolicy(value);
  assert.ok(result.findings.some(item => item.code === 'high-speed-two-layer-return-path-review' && item.subject === 'USB_FS'));
});

test('invalid target impedance fails the routing-policy readiness gate', () => {
  const value = intent();
  value.interfaces![1]!.targetImpedanceOhm = -90;
  const result = deriveKicadRoutingPolicy(value);
  assert.equal(result.ready, false);
  assert.ok(result.findings.some(item => item.code === 'invalid-target-impedance'));
});
