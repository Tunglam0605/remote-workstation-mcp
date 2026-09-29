import { SerialPort } from 'serialport';
import { PolicyEngine } from '../../policy.js';
import { EngineeringResourceManager } from './resource-manager.js';
import { validateSerialPortPath } from './serial-port-policy.js';

export type ModbusReadFunction = 1 | 2 | 3 | 4;
export type ModbusParity = 'none' | 'even' | 'odd';

export interface ModbusSerialOptions {
  baudRate?: number;
  dataBits?: 7 | 8;
  parity?: ModbusParity;
  stopBits?: 1 | 2;
  timeoutMs?: number;
}

export function modbusCrc16(frame: Uint8Array): number {
  let crc = 0xffff;
  for (const byte of frame) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) ? ((crc >>> 1) ^ 0xa001) : (crc >>> 1);
    }
  }
  return crc & 0xffff;
}

function validateUnitId(unitId: number): number {
  if (!Number.isInteger(unitId) || unitId < 1 || unitId > 247) throw new Error('Modbus unitId must be in range 1..247.');
  return unitId;
}

function validateAddress(address: number): number {
  if (!Number.isInteger(address) || address < 0 || address > 0xffff) throw new Error('Modbus address must be in range 0..65535.');
  return address;
}

function validateReadFunction(fn: number): asserts fn is ModbusReadFunction {
  if (![1, 2, 3, 4].includes(fn)) throw new Error('Modbus read function must be one of 01, 02, 03 or 04.');
}

function validateQuantity(fn: ModbusReadFunction, quantity: number): number {
  const max = fn === 1 || fn === 2 ? 2000 : 125;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > max) {
    throw new Error(`Modbus function ${fn} quantity must be in range 1..${max}.`);
  }
  return quantity;
}

function serialOptions(options: ModbusSerialOptions) {
  const baudRate = options.baudRate ?? 9600;
  const dataBits = options.dataBits ?? 8;
  const parity = options.parity ?? 'even';
  const stopBits = options.stopBits ?? 1;
  const timeoutMs = options.timeoutMs ?? 1000;
  if (!Number.isInteger(baudRate) || baudRate < 300 || baudRate > 12_000_000) throw new Error('baudRate must be 300..12000000.');
  if (![7, 8].includes(dataBits)) throw new Error('dataBits must be 7 or 8.');
  if (!['none', 'even', 'odd'].includes(parity)) throw new Error('parity must be none, even, or odd.');
  if (![1, 2].includes(stopBits)) throw new Error('stopBits must be 1 or 2.');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 30_000) throw new Error('timeoutMs must be 50..30000.');
  return { baudRate, dataBits, parity, stopBits, timeoutMs };
}

export function buildModbusReadRequest(unitId: number, fn: ModbusReadFunction, address: number, quantity: number): Buffer {
  validateReadFunction(fn);
  const body = Buffer.from([
    validateUnitId(unitId),
    fn,
    (validateAddress(address) >>> 8) & 0xff,
    address & 0xff,
    (validateQuantity(fn, quantity) >>> 8) & 0xff,
    quantity & 0xff
  ]);
  const crc = modbusCrc16(body);
  return Buffer.concat([body, Buffer.from([crc & 0xff, (crc >>> 8) & 0xff])]);
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

export function parseModbusReadResponse(frame: Buffer, unitId: number, fn: ModbusReadFunction, quantity: number) {
  validateReadFunction(fn);
  if (frame.length < 5) throw new Error('Modbus response is too short.');
  const receivedCrc = frame[frame.length - 2]! | (frame[frame.length - 1]! << 8);
  const computedCrc = modbusCrc16(frame.subarray(0, -2));
  if (receivedCrc !== computedCrc) throw new Error('Modbus response CRC mismatch.');
  if (frame[0] !== unitId) throw new Error(`Modbus response unit mismatch: expected ${unitId}, received ${frame[0]}.`);
  if (frame[1] === (fn | 0x80)) {
    const code = frame[2] ?? 0;
    return {
      ok: false as const,
      exception: { code, name: exceptionName(code) },
      rawHex: frame.toString('hex').toUpperCase()
    };
  }
  if (frame[1] !== fn) throw new Error(`Modbus response function mismatch: expected ${fn}, received ${frame[1]}.`);
  const byteCount = frame[2]!;
  if (frame.length !== byteCount + 5) throw new Error('Modbus response byte count/length mismatch.');
  const data = frame.subarray(3, 3 + byteCount);
  if (fn === 1 || fn === 2) {
    const bits: boolean[] = [];
    for (let i = 0; i < quantity; i += 1) bits.push(Boolean(data[Math.floor(i / 8)]! & (1 << (i % 8))));
    return { ok: true as const, bits, rawDataHex: data.toString('hex').toUpperCase(), rawHex: frame.toString('hex').toUpperCase() };
  }
  if (byteCount !== quantity * 2) throw new Error('Modbus register response byte count mismatch.');
  const registers: number[] = [];
  for (let i = 0; i < quantity; i += 1) registers.push(data.readUInt16BE(i * 2));
  return { ok: true as const, registers, rawDataHex: data.toString('hex').toUpperCase(), rawHex: frame.toString('hex').toUpperCase() };
}

async function transact(portPath: string, fn: ModbusReadFunction, unitId: number, address: number, quantity: number, options: ModbusSerialOptions) {
  const cfg = serialOptions(options);
  const serial = new SerialPort({
    path: portPath,
    baudRate: cfg.baudRate,
    dataBits: cfg.dataBits,
    parity: cfg.parity,
    stopBits: cfg.stopBits,
    autoOpen: false
  });
  const request = buildModbusReadRequest(unitId, fn, address, quantity);
  const expectedDataBytes = fn === 1 || fn === 2 ? Math.ceil(quantity / 8) : quantity * 2;
  const normalLength = 5 + expectedDataBytes;
  let buffer = Buffer.alloc(0);
  let timer: NodeJS.Timeout | undefined;
  try {
    await new Promise<void>((resolve, reject) => serial.open(error => error ? reject(error) : resolve()));
    return await new Promise<ReturnType<typeof parseModbusReadResponse>>((resolve, reject) => {
      const finish = (error?: Error, result?: ReturnType<typeof parseModbusReadResponse>) => {
        if (timer) clearTimeout(timer);
        serial.removeAllListeners('data');
        serial.removeAllListeners('error');
        if (error) reject(error);
        else resolve(result!);
      };
      timer = setTimeout(() => finish(new Error(`Modbus RTU timeout after ${cfg.timeoutMs} ms.`)), cfg.timeoutMs);
      serial.on('error', error => finish(error));
      serial.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length >= 5 && buffer[0] === unitId) {
          const exception = buffer[1] === (fn | 0x80);
          const targetLength = exception ? 5 : normalLength;
          if (buffer.length >= targetLength) {
            try { finish(undefined, parseModbusReadResponse(buffer.subarray(0, targetLength), unitId, fn, quantity)); }
            catch (error) { finish(error as Error); }
          }
        }
      });
      serial.write(request, error => {
        if (error) return finish(error);
        serial.drain(drainError => { if (drainError) finish(drainError); });
      });
    });
  } finally {
    if (serial.isOpen) await new Promise<void>(resolve => serial.close(() => resolve()));
  }
}

export class ModbusRtuAdapter {
  constructor(
    private readonly policy: PolicyEngine,
    private readonly resources: EngineeringResourceManager
  ) {}

  async providerStatus() {
    const ports = await SerialPort.list().catch(() => []);
    return {
      supported: true,
      backend: 'serialport',
      transport: 'modbus-rtu',
      serialPortCount: Math.min(ports.length, 256),
      authority: 'read-only-functions',
      supportedFunctions: [1, 2, 3, 4],
      unavailableFunctions: [5, 6, 15, 16, 22, 23],
      unavailable: ['write coil/register', 'mask write', 'read-write multiple registers', 'broadcast write', 'raw RTU frame injection']
    };
  }

  async endpointStatus(port: string) {
    const selected = validateSerialPortPath(port);
    const ports = await SerialPort.list();
    const found = ports.find(item => item.path.toLowerCase() === selected.toLowerCase());
    return {
      port: selected,
      discovered: Boolean(found),
      ...(found ? {
        manufacturer: found.manufacturer,
        serialNumber: found.serialNumber,
        vendorId: found.vendorId,
        productId: found.productId,
        pnpId: found.pnpId
      } : {})
    };
  }

  async read(port: string, unitId: number, fn: ModbusReadFunction, address: number, quantity: number, options: ModbusSerialOptions = {}) {
    this.policy.assertEngineeringExecute();
    const selected = validateSerialPortPath(port);
    validateUnitId(unitId);
    validateAddress(address);
    validateQuantity(fn, quantity);
    const cfg = serialOptions(options);
    return await this.resources.withLease(`serial:${selected}`, 'monitoring', async () => ({
      port: selected,
      unitId,
      function: fn,
      address,
      quantity,
      serial: { baudRate: cfg.baudRate, dataBits: cfg.dataBits, parity: cfg.parity, stopBits: cfg.stopBits, timeoutMs: cfg.timeoutMs },
      response: await transact(selected, fn, unitId, address, quantity, cfg)
    }));
  }

  async probe(port: string, unitIds: number[], options: ModbusSerialOptions & { function?: ModbusReadFunction; address?: number } = {}) {
    this.policy.assertEngineeringExecute();
    const selected = validateSerialPortPath(port);
    if (unitIds.length < 1 || unitIds.length > 32) throw new Error('Modbus probe accepts 1..32 explicit unit IDs.');
    const unique = [...new Set(unitIds.map(validateUnitId))];
    if (unique.length !== unitIds.length) throw new Error('Modbus probe unit IDs must be unique.');
    const fn = options.function ?? 3;
    const address = validateAddress(options.address ?? 0);
    const cfg = serialOptions(options);
    return await this.resources.withLease(`serial:${selected}`, 'monitoring', async () => {
      const devices: Array<Record<string, unknown>> = [];
      for (const unitId of unique) {
        try {
          const response = await transact(selected, fn, unitId, address, 1, cfg);
          devices.push({ unitId, responded: true, response });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          devices.push({ unitId, responded: false, timeout: /timeout/i.test(message), error: message.slice(0, 256) });
        }
      }
      return {
        port: selected,
        function: fn,
        address,
        serial: { baudRate: cfg.baudRate, dataBits: cfg.dataBits, parity: cfg.parity, stopBits: cfg.stopBits, timeoutMs: cfg.timeoutMs },
        requestedUnitIds: unique,
        devices,
        respondedUnitIds: devices.filter(item => item.responded === true).map(item => item.unitId)
      };
    });
  }
}
