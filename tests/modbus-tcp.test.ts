import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import {
  ModbusTcpAdapter,
  buildModbusTcpReadRequest,
  parseModbusTcpReadResponse
} from '../src/extensions/modbus-tcp/modbus-tcp-adapter.js';

function response(
  transactionId: number,
  unitId: number,
  functionCode: number,
  body: number[]
): Buffer {
  const payload = Buffer.from([unitId, functionCode, ...body]);
  const frame = Buffer.alloc(6 + payload.length);
  frame.writeUInt16BE(transactionId, 0);
  frame.writeUInt16BE(0, 2);
  frame.writeUInt16BE(payload.length, 4);
  payload.copy(frame, 6);
  return frame;
}

test('Modbus TCP read request emits a correct MBAP header and read PDU', () => {
  const request = buildModbusTcpReadRequest(0x1234, 7, 3, 0x0010, 2);
  assert.equal(request.length, 12);
  assert.equal(request.readUInt16BE(0), 0x1234);
  assert.equal(request.readUInt16BE(2), 0);
  assert.equal(request.readUInt16BE(4), 6);
  assert.equal(request[6], 7);
  assert.equal(request[7], 3);
  assert.equal(request.readUInt16BE(8), 0x0010);
  assert.equal(request.readUInt16BE(10), 2);
});

test('Modbus TCP register response validates MBAP fields and decodes registers', () => {
  const frame = response(0x1234, 7, 3, [4, 0x12, 0x34, 0xab, 0xcd]);
  const parsed = parseModbusTcpReadResponse(frame, 0x1234, 7, 3, 2);
  assert.deepEqual(parsed, {
    ok: true,
    registers: [0x1234, 0xabcd],
    rawDataHex: '1234ABCD'
  });
  assert.throws(() => parseModbusTcpReadResponse(frame, 0x9999, 7, 3, 2), /transaction identifier mismatch/i);
  assert.throws(() => parseModbusTcpReadResponse(frame, 0x1234, 8, 3, 2), /unit mismatch/i);
});

test('Modbus TCP bit response decodes LSB-first coils and validates byte count', () => {
  const frame = response(4, 2, 1, [2, 0b00000101, 0b00000001]);
  const parsed = parseModbusTcpReadResponse(frame, 4, 2, 1, 9);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.ok ? parsed.bits : [], [true, false, true, false, false, false, false, false, true]);
});

test('Modbus TCP exception response is returned as typed evidence', () => {
  const frame = response(11, 3, 0x83, [2]);
  const parsed = parseModbusTcpReadResponse(frame, 11, 3, 3, 1);
  assert.deepEqual(parsed, {
    ok: false,
    exception: { code: 2, name: 'illegal-data-address' },
    rawPduHex: '8302'
  });
});

test('Modbus TCP request validation enforces read-only functions and quantity limits', () => {
  assert.throws(() => buildModbusTcpReadRequest(1, 1, 5 as never, 0, 1), /read function/i);
  assert.throws(() => buildModbusTcpReadRequest(1, 1, 3, 0, 126), /1\.\.125/);
  assert.throws(() => buildModbusTcpReadRequest(1, 1, 1, 0, 2001), /1\.\.2000/);
  assert.throws(() => buildModbusTcpReadRequest(1, 256, 3, 0, 1), /unitId/i);
});

test('Modbus TCP adapter performs one bounded read against an explicit loopback endpoint', async () => {
  const server = net.createServer(socket => {
    socket.once('data', request => {
      const transactionId = request.readUInt16BE(0);
      const unitId = request[6]!;
      const fn = request[7]!;
      socket.end(response(transactionId, unitId, fn, [2, 0x12, 0x34]));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  let policyChecks = 0;
  const adapter = new ModbusTcpAdapter({
    assertEngineeringExecute() { policyChecks += 1; }
  } as never);

  try {
    const result = await adapter.read('127.0.0.1', 1, 3, 0, 1, {
      port: address.port,
      timeoutMs: 1_000
    });
    assert.equal(policyChecks, 1);
    assert.equal(result.response.ok, true);
    assert.deepEqual(result.response.ok ? result.response.registers : [], [0x1234]);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('Modbus TCP probe touches only the explicit Unit IDs supplied by the caller', async () => {
  const seen: number[] = [];
  const server = net.createServer(socket => {
    socket.once('data', request => {
      const transactionId = request.readUInt16BE(0);
      const unitId = request[6]!;
      const fn = request[7]!;
      seen.push(unitId);
      socket.end(response(transactionId, unitId, fn, [2, 0x00, unitId]));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const adapter = new ModbusTcpAdapter({
    assertEngineeringExecute() {}
  } as never);

  try {
    const result = await adapter.probe('127.0.0.1', [2, 7], {
      port: address.port,
      function: 3,
      address: 0,
      timeoutMs: 500
    });
    assert.deepEqual(seen, [2, 7]);
    assert.deepEqual(result.respondedUnitIds, [2, 7]);
    await assert.rejects(
      () => adapter.probe('127.0.0.1', [2, 2], { port: address.port }),
      /must be unique/i
    );
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
