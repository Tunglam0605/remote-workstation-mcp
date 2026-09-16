import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeCortexMFault } from '../src/adapters/engineering/fault-decode.js';

test('fault decoder reports precise BusFault and valid BFAR', () => {
  const decoded = decodeCortexMFault({
    cfsr: (1 << 9) | (1 << 15),
    hfsr: (1 << 30),
    bfar: 0x20001234
  });
  assert.equal(decoded.summary.busFault, true);
  assert.equal(decoded.summary.forcedEscalation, true);
  assert.equal(decoded.faultAddresses.bfar, 0x20001234);
  assert.ok(decoded.details.some(item => item.startsWith('PRECISERR')));
});

test('fault decoder does not report invalid fault addresses', () => {
  const decoded = decodeCortexMFault({ cfsr: 1 << 9, hfsr: 0, bfar: 0xDEADBEEF });
  assert.equal(decoded.faultAddresses.bfar, undefined);
});
