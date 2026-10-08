import assert from 'node:assert/strict';
import test from 'node:test';
import {
  planKicadSchematicArchitecture,
  validateKicadSchematicArchitectureCoverage
} from '../src/adapters/engineering/kicad-schematic-architecture.js';
import type { KicadDevicePinPlan, KicadElectronicDesignIntent } from '../src/adapters/engineering/kicad-design-intent.js';

const intent: KicadElectronicDesignIntent = {
  schemaVersion: 1,
  name: 'Robot control',
  rails: [
    { name: 'GND', nominalVoltageV: 0, source: 'derived', isGround: true },
    { name: '3V3', nominalVoltageV: 3.3, source: 'regulator' }
  ],
  devices: [
    {
      reference: 'U1', role: 'mcu', partNumber: 'STM32F407VGT6', package: 'LQFP100',
      supplyRails: ['3V3', 'GND'], requiredSignals: ['CAN1_TX', 'CAN1_RX'],
      clocks: [{ name: 'HSE', frequencyHz: 8_000_000, source: 'crystal' }],
      debug: { interface: 'swd', connectorRequired: true, preservePins: true, resetSignal: 'NRST' }
    },
    { reference: 'U2', role: 'transceiver', partNumber: 'TJA1051', supplyRails: ['3V3', 'GND'] },
    { reference: 'J1', role: 'connector' }
  ],
  interfaces: [{
    id: 'CAN_EXT', kind: 'can', signals: ['CAN_H', 'CAN_L'], deviceRefs: ['U2', 'J1'],
    external: true, terminationRequired: true, protectionRequired: true
  }]
};

const pinPlans: KicadDevicePinPlan[] = [{
  deviceRef: 'U1', partNumber: 'STM32F407VGT6', package: 'LQFP100', source: 'stm32-cubemx',
  assignments: [
    { logicalSignal: 'CAN1_TX', physicalPin: 'PA12', peripheralSignal: 'CAN1_TX', packagePosition: '69' },
    { logicalSignal: 'CAN1_RX', physicalPin: 'PA11', peripheralSignal: 'CAN1_RX', packagePosition: '68' },
    { logicalSignal: 'SWDIO', physicalPin: 'PA13', peripheralSignal: 'SYS_JTMS-SWDIO', packagePosition: '72' },
    { logicalSignal: 'SWCLK', physicalPin: 'PA14', peripheralSignal: 'SYS_JTCK-SWCLK', packagePosition: '76' }
  ]
}];

test('schematic architecture derives power, local decoupling, clock, reset/debug and external-interface requirements', () => {
  const plan = planKicadSchematicArchitecture(intent, pinPlans);
  assert.equal(plan.ready, true);
  assert.ok(plan.requirements.some(item => item.kind === 'bulk-decoupling' && item.subject === '3V3'));
  assert.ok(plan.requirements.some(item => item.kind === 'local-decoupling' && item.subject === 'U1'));
  assert.ok(plan.requirements.some(item => item.kind === 'clock-network' && item.subject === 'U1'));
  assert.ok(plan.requirements.some(item => item.kind === 'reset-network' && item.subject === 'U1'));
  assert.ok(plan.requirements.some(item => item.kind === 'debug-connector' && item.nets.includes('SWDIO')));
  assert.ok(plan.requirements.some(item => item.kind === 'interface-protection' && item.subject === 'CAN_EXT'));
  assert.ok(plan.requirements.some(item => item.kind === 'interface-termination' && item.subject === 'CAN_EXT'));
});

test('schematic architecture fails closed when MCU pin plan is absent', () => {
  const plan = planKicadSchematicArchitecture(intent, []);
  assert.equal(plan.ready, false);
  assert.ok(plan.findings.some(item => item.code === 'architecture-pin-plan-missing'));
});

test('schematic coverage requires all design-intent devices, supplies and interface signals before synthesis', () => {
  const result = validateKicadSchematicArchitectureCoverage({
    intent,
    pinPlans,
    componentReferences: ['U1', 'U2', 'J1'],
    netNames: ['3V3', 'GND', 'CAN1_TX', 'CAN1_RX', 'CAN_H', 'CAN_L']
  });
  assert.equal(result.valid, true);

  const bad = validateKicadSchematicArchitectureCoverage({
    intent,
    pinPlans,
    componentReferences: ['U1', 'J1'],
    netNames: ['GND', 'CAN1_TX', 'CAN_H']
  });
  assert.equal(bad.valid, false);
  assert.ok(bad.findings.some(item => item.code === 'architecture-device-missing-from-schematic' && item.subject === 'U2'));
  assert.ok(bad.findings.some(item => item.code === 'architecture-supply-net-missing' && /3V3/.test(item.message)));
  assert.ok(bad.findings.some(item => item.code === 'architecture-interface-net-missing' && /CAN_L/.test(item.message)));
});
