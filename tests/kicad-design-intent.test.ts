import assert from 'node:assert/strict';
import test from 'node:test';
import {
  stm32AssignmentsToKicadPinPlan,
  validateKicadElectronicDesignIntent,
  type KicadElectronicDesignIntent
} from '../src/adapters/engineering/kicad-design-intent.js';

function baseIntent(): KicadElectronicDesignIntent {
  return {
    schemaVersion: 1,
    name: 'Robot Controller',
    board: { widthMm: 80, heightMm: 60, copperLayers: 4, thicknessMm: 1.6 },
    rails: [
      { name: 'GND', nominalVoltageV: 0, source: 'derived', isGround: true },
      { name: '3V3', nominalVoltageV: 3.3, currentBudgetA: 1.2, source: 'regulator' }
    ],
    devices: [
      {
        reference: 'U1',
        role: 'mcu',
        partNumber: 'STM32F407VGT6',
        package: 'LQFP100',
        supplyRails: ['3V3', 'GND'],
        requiredSignals: ['CAN1_TX', 'CAN1_RX'],
        clocks: [{ name: 'HSE', frequencyHz: 8_000_000, source: 'crystal', critical: true }],
        debug: { interface: 'swd', preservePins: true, connectorRequired: true, resetSignal: 'NRST' }
      },
      { reference: 'U2', role: 'transceiver', partNumber: 'TJA1051', supplyRails: ['3V3', 'GND'] },
      { reference: 'J1', role: 'connector' }
    ],
    interfaces: [
      {
        id: 'CAN_EXT',
        kind: 'can',
        signals: ['CAN_H', 'CAN_L'],
        deviceRefs: ['U2', 'J1'],
        external: true,
        nominalBitrate: 1_000_000,
        terminationRequired: true,
        protectionRequired: true
      }
    ],
    functionalBlocks: [
      { id: 'CONTROL', deviceRefs: ['U1'], keepTogether: true },
      { id: 'CAN_IO', deviceRefs: ['U2', 'J1'], preferredRegion: 'connector-edge', keepTogether: true }
    ]
  };
}

test('electronic design intent requires a programmable-device pin plan before schematic release', () => {
  const result = validateKicadElectronicDesignIntent(baseIntent());
  assert.equal(result.valid, false);
  assert.equal(result.gates.pinPlanReady, false);
  assert.ok(result.findings.some(item => item.code === 'pin-plan-missing' && item.subject === 'U1'));
  assert.ok(result.findings.some(item => item.code === 'external-interface-protection-review'));
  assert.ok(result.findings.some(item => item.code === 'interface-termination-review'));
});

test('STM32 CubeMX assignments bridge into the generic board pin-plan gate', () => {
  const intent = baseIntent();
  const plan = stm32AssignmentsToKicadPinPlan(intent.devices[0]!, [
    { request: 'CAN1_TX', signal: 'CAN1_TX', pinName: 'PA12', position: '69', pinType: 'I/O', candidateCount: 2 },
    { request: 'CAN1_RX', signal: 'CAN1_RX', pinName: 'PA11', position: '68', pinType: 'I/O', candidateCount: 2 }
  ], ['PA13', 'PA14']);
  const result = validateKicadElectronicDesignIntent(intent, [plan]);
  assert.equal(result.valid, true);
  assert.equal(result.gates.pinPlanReady, true);
  assert.equal(plan.source, 'stm32-cubemx');
  assert.deepEqual(plan.reservedPins, ['PA13', 'PA14']);
  assert.equal(plan.assignments[0]?.physicalPin, 'PA12');
  assert.ok(result.findings.some(item => item.code === 'clock-placement-review'));
});

test('design intent reports undefined rails/devices and missing required pin signals as hard errors', () => {
  const intent = baseIntent();
  intent.devices[1]!.supplyRails = ['5V'];
  intent.interfaces![0]!.deviceRefs = ['U2', 'J404'];
  const plan = stm32AssignmentsToKicadPinPlan(intent.devices[0]!, [
    { request: 'CAN1_TX', signal: 'CAN1_TX', pinName: 'PA12', position: '69', pinType: 'I/O', candidateCount: 2 }
  ]);
  const result = validateKicadElectronicDesignIntent(intent, [plan]);
  assert.equal(result.valid, false);
  assert.ok(result.findings.some(item => item.code === 'unknown-device-rail'));
  assert.ok(result.findings.some(item => item.code === 'unknown-interface-device'));
  assert.ok(result.findings.some(item => item.code === 'required-signal-unassigned' && /CAN1_RX/.test(item.message)));
});

test('design intent fails closed on duplicate rails and invalid ground voltage', () => {
  const duplicate = baseIntent();
  duplicate.rails.push({ name: '3v3', nominalVoltageV: 3.3, source: 'derived' });
  assert.throws(() => validateKicadElectronicDesignIntent(duplicate), /Duplicate design rails/);

  const ground = baseIntent();
  ground.rails[0]!.nominalVoltageV = 0.1;
  assert.throws(() => validateKicadElectronicDesignIntent(ground), /Ground rail GND nominal voltage must be 0 V/);
});
