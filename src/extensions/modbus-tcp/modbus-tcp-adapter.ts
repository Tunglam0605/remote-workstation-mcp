import net from 'node:net';
import { PolicyEngine } from '../../policy.js';

export type ModbusTcpReadFunction = 1 | 2 | 3 | 4;

export interface ModbusTcpOptions {
  port?: number;
  timeoutMs?: number;
}

function validateHost(value: string): string {
  const host = value.trim();
  if (!host || host.length > 253) throw new Error('Modbus TCP host must be 1..253 characters.');
  if (net.isIP(host)) return host;
  if (!/^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(host)) {
    throw new Error('Modbus TCP host must be a valid IPv4, IPv6, or DNS hostname.');
  }
  return host;
}

function validatePort(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) throw new Error('Modbus TCP port must be in range 1..65535.');
  return value;
}

function validateUnitId(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 255) throw new Error('Modbus TCP unitId must be in range 0..255.');
  return value;
}

function validateAddress(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) throw new Error('Modbus address must be in range 0..65535.');
  return value;
}

function validateFunction(value: number): asserts value is ModbusTcpReadFunction {
  if (![1, 2, 3, 4].includes(value)) throw new Error('Modbus TCP read function must be one of 01, 02, 03 or 04.');
}

function validateQuantity(fn: ModbusTcpReadFunction, value: number): number {
  const max = fn === 1 || fn === 2 ? 2000 : 125;
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`Modbus function ${fn} quantity must be in range 1..${max}.`);
  }
  return value;
}

function validateTimeout(value: number): number {
  if (!Number.isInteger(value) || value < 50 || value > 10_000) throw new Error('Modbus TCP timeoutMs must be in range 50..10000.');
  return value;
}

function exceptionName(code: number): string {
  return ({
    1: 'illegal-function',
    2: 'illegal-data-address',
    3: 'illegal-data-value',
    4: 'server-device-failure',
    5: 'acknowledge',
    6: 'server-device-busy',
    8: 'memory-parity-error',
    10: 'gateway-path-unavailable',
    11: 'gateway-target-failed-to-respond'
  } as Record<number, string>)[code] ?? 'unknown-exception';
}

export function buildModbusTcpReadRequest(
  transactionId: number,
  unitId: number,
  fn: ModbusTcpReadFunction,
  address: number,
  quantity: number
): Buffer {
  if (!Number.isInteger(transactionId) || transactionId < 0 || transactionId > 0xffff) throw new Error('transactionId must be in range 0..65535.');
  validateFunction(fn);
  const frame = Buffer.alloc(12);
  frame.writeUInt16BE(transactionId, 0);
  frame.writeUInt16BE(0, 2); // Protocol Identifier must be zero.
  frame.writeUInt16BE(6, 4); // Unit identifier + 5-byte request PDU.
  frame[6] = validateUnitId(unitId);
  frame[7] = fn;
  frame.writeUInt16BE(validateAddress(address), 8);
  frame.writeUInt16BE(validateQuantity(fn, quantity), 10);
  return frame;
}

export function parseModbusTcpReadResponse(
  frame: Buffer,
  transactionId: number,
  unitId: number,
  fn: ModbusTcpReadFunction,
  quantity: number
) {
  validateFunction(fn);
  if (frame.length < 9) throw new Error('Modbus TCP response is too short.');
  if (frame.readUInt16BE(0) !== transactionId) throw new Error('Modbus TCP transaction identifier mismatch.');
  if (frame.readUInt16BE(2) !== 0) throw new Error('Modbus TCP protocol identifier must be zero.');
  const length = frame.readUInt16BE(4);
  if (length < 3 || length > 254 || frame.length !== 6 + length) throw new Error('Modbus TCP MBAP length mismatch.');
  if (frame[6] !== unitId) throw new Error(`Modbus TCP unit mismatch: expected ${unitId}, received ${frame[6]}.`);
  const responseFn = frame[7]!;
  if (responseFn === (fn | 0x80)) {
    const code = frame[8] ?? 0;
    return {
      ok: false as const,
      exception: { code, name: exceptionName(code) },
      rawPduHex: frame.subarray(7).toString('hex').toUpperCase()
    };
  }
  if (responseFn !== fn) throw new Error(`Modbus TCP response function mismatch: expected ${fn}, received ${responseFn}.`);
  const byteCount = frame[8]!;
  if (frame.length !== 9 + byteCount) throw new Error('Modbus TCP response byte count/length mismatch.');
  const data = frame.subarray(9);
  if (fn === 1 || fn === 2) {
    const expectedBytes = Math.ceil(quantity / 8);
    if (byteCount !== expectedBytes) throw new Error('Modbus TCP bit response byte count mismatch.');
    const bits: boolean[] = [];
    for (let i = 0; i < quantity; i += 1) bits.push(Boolean(data[Math.floor(i / 8)]! & (1 << (i % 8))));
    return { ok: true as const, bits, rawDataHex: data.toString('hex').toUpperCase() };
  }
  if (byteCount !== quantity * 2) throw new Error('Modbus TCP register response byte count mismatch.');
  const registers: number[] = [];
  for (let i = 0; i < quantity; i += 1) registers.push(data.readUInt16BE(i * 2));
  return { ok: true as const, registers, rawDataHex: data.toString('hex').toUpperCase() };
}

async function connect(host: string, port: number, timeoutMs: number): Promise<net.Socket> {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Modbus TCP connection timeout after ${timeoutMs} ms.`));
    }, timeoutMs);
    const onError = (error: Error) => {
      clearTimeout(timer);
      reject(error);
    };
    socket.once('error', onError);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.off('error', onError);
      socket.setNoDelay(true);
      resolve(socket);
    });
  });
}

async function transact(
  host: string,
  port: number,
  unitId: number,
  fn: ModbusTcpReadFunction,
  address: number,
  quantity: number,
  timeoutMs: number,
  transactionId: number
) {
  const socket = await connect(host, port, timeoutMs);
  let buffer = Buffer.alloc(0);
  try {
    return await new Promise<ReturnType<typeof parseModbusTcpReadResponse>>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, value?: ReturnType<typeof parseModbusTcpReadResponse>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.removeAllListeners('data');
        socket.removeAllListeners('error');
        socket.removeAllListeners('close');
        if (error) reject(error);
        else resolve(value!);
      };
      const timer = setTimeout(() => finish(new Error(`Modbus TCP response timeout after ${timeoutMs} ms.`)), timeoutMs);
      socket.on('error', error => finish(error));
      socket.on('close', () => finish(new Error('Modbus TCP connection closed before a complete response.')));
      socket.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length > 260) return finish(new Error('Modbus TCP response exceeds bounded ADU size.'));
        if (buffer.length >= 6) {
          const length = buffer.readUInt16BE(4);
          if (length < 3 || length > 254) return finish(new Error('Modbus TCP MBAP length is invalid.'));
          const expected = 6 + length;
          if (buffer.length >= expected) {
            if (buffer.length !== expected) return finish(new Error('Modbus TCP response contains unexpected trailing bytes.'));
            try { finish(undefined, parseModbusTcpReadResponse(buffer, transactionId, unitId, fn, quantity)); }
            catch (error) { finish(error as Error); }
          }
        }
      });
      socket.write(buildModbusTcpReadRequest(transactionId, unitId, fn, address, quantity), error => {
        if (error) finish(error);
      });
    });
  } finally {
    socket.destroy();
  }
}

export class ModbusTcpAdapter {
  private transaction = 0;

  constructor(private readonly policy: PolicyEngine) {}

  private nextTransactionId(): number {
    this.transaction = (this.transaction + 1) & 0xffff;
    return this.transaction;
  }

  async providerStatus() {
    return {
      supported: true,
      backend: 'node:net',
      transport: 'modbus-tcp',
      defaultPort: 502,
      authority: 'read-only-functions',
      supportedFunctions: [1, 2, 3, 4],
      unavailableFunctions: [5, 6, 15, 16, 22, 23],
      directServerRecommendedUnitId: 255,
      unavailable: ['write coil/register', 'mask write', 'read-write multiple registers', 'broadcast write', 'raw PDU injection', 'subnet scan', 'server configuration']
    };
  }

  async endpointStatus(host: string, options: ModbusTcpOptions = {}) {
    this.policy.assertEngineeringExecute();
    const selectedHost = validateHost(host);
    const port = validatePort(options.port ?? 502);
    const timeoutMs = validateTimeout(options.timeoutMs ?? 1_000);
    const started = Date.now();
    try {
      const socket = await connect(selectedHost, port, timeoutMs);
      socket.destroy();
      return { host: selectedHost, port, reachable: true, durationMs: Date.now() - started };
    } catch (error) {
      return {
        host: selectedHost,
        port,
        reachable: false,
        durationMs: Date.now() - started,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 256)
      };
    }
  }

  async read(
    host: string,
    unitId: number,
    fn: ModbusTcpReadFunction,
    address: number,
    quantity: number,
    options: ModbusTcpOptions = {}
  ) {
    this.policy.assertEngineeringExecute();
    const selectedHost = validateHost(host);
    const port = validatePort(options.port ?? 502);
    const timeoutMs = validateTimeout(options.timeoutMs ?? 1_000);
    validateUnitId(unitId);
    validateAddress(address);
    validateQuantity(fn, quantity);
    const transactionId = this.nextTransactionId();
    return {
      host: selectedHost,
      port,
      unitId,
      function: fn,
      address,
      quantity,
      timeoutMs,
      transactionId,
      response: await transact(selectedHost, port, unitId, fn, address, quantity, timeoutMs, transactionId)
    };
  }

  async probe(
    host: string,
    unitIds: number[],
    options: ModbusTcpOptions & { function?: ModbusTcpReadFunction; address?: number } = {}
  ) {
    this.policy.assertEngineeringExecute();
    const selectedHost = validateHost(host);
    if (unitIds.length < 1 || unitIds.length > 32) throw new Error('Modbus TCP probe accepts 1..32 explicit unit IDs.');
    const unique = [...new Set(unitIds.map(validateUnitId))];
    if (unique.length !== unitIds.length) throw new Error('Modbus TCP probe unit IDs must be unique.');
    const port = validatePort(options.port ?? 502);
    const timeoutMs = validateTimeout(Math.min(options.timeoutMs ?? 500, 3_000));
    const fn = options.function ?? 3;
    const address = validateAddress(options.address ?? 0);
    validateFunction(fn);
    const devices: Array<Record<string, unknown>> = [];
    for (const unitId of unique) {
      const transactionId = this.nextTransactionId();
      try {
        const response = await transact(selectedHost, port, unitId, fn, address, 1, timeoutMs, transactionId);
        devices.push({ unitId, responded: true, response });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        devices.push({ unitId, responded: false, timeout: /timeout/i.test(message), error: message.slice(0, 256) });
      }
    }
    return {
      host: selectedHost,
      port,
      function: fn,
      address,
      timeoutMs,
      requestedUnitIds: unique,
      devices,
      respondedUnitIds: devices.filter(item => item.responded === true).map(item => item.unitId)
    };
  }
}
