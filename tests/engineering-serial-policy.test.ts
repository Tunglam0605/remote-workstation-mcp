import assert from 'node:assert/strict';
import test from 'node:test';
import { validateSerialPortPath } from '../src/adapters/engineering/serial-port-policy.js';

test('serial port policy accepts canonical Windows and Linux device paths', () => {
  assert.equal(validateSerialPortPath('COM18', 'win32'), 'COM18');
  assert.equal(validateSerialPortPath('/dev/ttyUSB0', 'linux'), '/dev/ttyUSB0');
  assert.equal(validateSerialPortPath('/dev/serial/by-id/usb-STMicroelectronics_STLINK-V3_ABC-if02', 'linux'), '/dev/serial/by-id/usb-STMicroelectronics_STLINK-V3_ABC-if02');
});

test('serial port policy rejects option-like, traversal and non-device values', () => {
  assert.throws(() => validateSerialPortPath('-p', 'win32'), /serial port/i);
  assert.throws(() => validateSerialPortPath('COM0', 'win32'), /serial port/i);
  assert.throws(() => validateSerialPortPath('/tmp/ttyUSB0', 'linux'), /serial port/i);
  assert.throws(() => validateSerialPortPath('/dev/../tmp/evil', 'linux'), /serial port/i);
  assert.throws(() => validateSerialPortPath('/dev/tty USB0', 'linux'), /serial port/i);
});
