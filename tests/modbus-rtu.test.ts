import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildModbusReadRequest,
  modbusCrc16,
  parseModbusReadResponse
} from '../src/adapters/engineering/modbus-rtu.js';

function withCrc(bytes: number[]): Buffer {
  const body = Buffer.from(bytes);
  const crc = modbusCrc16(body);
  return Buffer.concat([body, Buffer.from([crc & 0xff, (crc >>> 8) & 0xff])]);
}

test('Modbus CRC16 and FC03 request match a standard RTU vector', () => {
  const request = buildModbusReadRequest(1, 3, 0, 10);
  assert.equal(request.toString('hex').toUpperCase(), '01030000000AC5CD');
  assert.equal(modbusCrc16(Buffer.from('01030000000A', 'hex')), 0xcdc5);
});

test('Modbus FC01/02 decode bounded packed bits in LSB-first order', () => {
  const response = withCrc([1, 1, 2, 0b01010101, 0b00000011]);
  const parsed = parseModbusReadResponse(response, 1, 1, 10);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.bits, [true, false, true, false, true, false, true, false, true, true]);
  assert.equal(parsed.rawDataHex, '5503');
});

test('Modbus FC03/04 decode unsigned 16-bit big-endian registers', () => {
  const response = withCrc([7, 4, 4, 0x12, 0x34, 0xab, 0xcd]);
  const parsed = parseModbusReadResponse(response, 7, 4, 2);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.registers, [0x1234, 0xabcd]);
});

test('Modbus exception response is decoded without treating it as protocol corruption', () => {
  const response = withCrc([3, 0x83, 2]);
  const parsed = parseModbusReadResponse(response, 3, 3, 1);
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.deepEqual(parsed.exception, { code: 2, name: 'illegal-data-address' });
});

test('Modbus validation rejects broadcast/read misuse, write functions and protocol overflow', () => {
  assert.throws(() => buildModbusReadRequest(0, 3, 0, 1), /unitId/i);
  assert.throws(() => buildModbusReadRequest(248, 3, 0, 1), /unitId/i);
  assert.throws(() => buildModbusReadRequest(1, 3, 65536, 1), /address/i);
  assert.throws(() => buildModbusReadRequest(1, 3, 0, 126), /quantity/i);
  assert.throws(() => buildModbusReadRequest(1, 1, 0, 2001), /quantity/i);
  assert.throws(() => buildModbusReadRequest(1, 5 as never, 0, 1), /quantity|function/i);
});

test('Modbus response validation fails closed on CRC/unit/function/byte-count mismatch', () => {
  const good = withCrc([1, 3, 2, 0, 42]);
  const badCrc = Buffer.from(good);
  badCrc[badCrc.length - 1] ^= 0xff;
  assert.throws(() => parseModbusReadResponse(badCrc, 1, 3, 1), /CRC/i);
  assert.throws(() => parseModbusReadResponse(good, 2, 3, 1), /unit mismatch/i);
  assert.throws(() => parseModbusReadResponse(good, 1, 4, 1), /function mismatch/i);
  const badCount = withCrc([1, 3, 4, 0, 42]);
  assert.throws(() => parseModbusReadResponse(badCount, 1, 3, 1), /byte count|length/i);
});
