import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveSerialDevice } from '../src/adapters/engineering/hardware-discovery.js';
import type { HardwareDevice } from '../src/engineering/types.js';

function serial(id: string, path: string, serialNumber?: string): HardwareDevice {
  return {
    id,
    kind: 'serial',
    name: 'USB UART',
    path,
    ...(serialNumber ? { serialNumber } : {}),
    vendorId: '10C4',
    productId: 'EA60',
    manufacturer: 'Silicon Labs',
    provider: 'serialport',
    capabilities: ['serial-monitor', 'serial-write']
  };
}

test('stable serial selector follows the same USB identity across OS path re-enumeration', () => {
  const selector = { serialNumber: 'UART-ABC', vendorId: '10c4', productId: 'ea60' };
  const before = resolveSerialDevice([serial('serial:one', 'COM7', 'UART-ABC')], selector);
  const after = resolveSerialDevice([serial('serial:one', 'COM11', 'UART-ABC')], selector);
  assert.equal(before.path, 'COM7');
  assert.equal(after.path, 'COM11');
  assert.equal(after.device.serialNumber, 'UART-ABC');
});

test('VID/PID-only selector fails closed when multiple serial devices match', () => {
  assert.throws(
    () => resolveSerialDevice([
      serial('serial:a', '/dev/ttyUSB0', 'A'),
      serial('serial:b', '/dev/ttyUSB1', 'B')
    ], { vendorId: '10C4', productId: 'EA60' }),
    /ambiguous/i
  );
});

test('friendly selector cannot replace a stable serial identity', () => {
  assert.throws(
    () => resolveSerialDevice([serial('serial:a', 'COM7', 'A')], { nameContains: 'UART' }),
    /deviceId|serialNumber|vendorId/i
  );
});

test('deviceId or serialNumber can disambiguate otherwise identical adapters', () => {
  const devices = [
    serial('serial:a', '/dev/ttyUSB0', 'A'),
    serial('serial:b', '/dev/ttyUSB1', 'B')
  ];
  assert.equal(resolveSerialDevice(devices, { deviceId: 'serial:b' }).path, '/dev/ttyUSB1');
  assert.equal(resolveSerialDevice(devices, { serialNumber: 'A' }).path, '/dev/ttyUSB0');
});
