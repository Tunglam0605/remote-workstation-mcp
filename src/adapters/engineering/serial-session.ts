import { randomUUID } from 'node:crypto';
import { SerialPort } from 'serialport';
import type { SerialReadResult, SerialSessionSnapshot } from '../../engineering/types.js';
import { PolicyEngine } from '../../policy.js';
import { resolveResourceOwner, type ResourceOwnerSource } from '../../security/execution-context.js';
import { EngineeringResourceManager } from './resource-manager.js';
import { validateSerialPortPath } from './serial-port-policy.js';

type ManagedSerial = SerialSessionSnapshot & {
  ownerId: string;
  serial: SerialPort;
  leaseId: string;
  buffer: Buffer;
  bufferBase: number;
};

export class SerialSessionManager {
  private readonly sessions = new Map<string, ManagedSerial>();

  constructor(
    private readonly policy: PolicyEngine,
    private readonly resources: EngineeringResourceManager,
    private readonly ownerIdSource: ResourceOwnerSource = 'unknown'
  ) {}

  private ownerId(): string {
    return resolveResourceOwner(this.ownerIdSource).key;
  }

  private owned(id: string): ManagedSerial {
    const session = this.sessions.get(id);
    if (!session || session.ownerId !== this.ownerId()) throw new Error(`Unknown serial session '${id}'.`);
    return session;
  }

  async open(port: string, baudRate: number): Promise<SerialSessionSnapshot> {
    this.policy.assertEngineeringExecute();
    port = validateSerialPortPath(port);
    if (!Number.isInteger(baudRate) || baudRate < 300 || baudRate > 12_000_000) {
      throw new Error('baudRate must be an integer in range 300..12000000.');
    }
    const resourceId = `serial:${port}`;
    const lease = this.resources.acquire(resourceId, 'monitoring');
    const serial = new SerialPort({ path: port, baudRate, autoOpen: false });
    try {
      await new Promise<void>((resolve, reject) => serial.open(error => error ? reject(error) : resolve()));
    } catch (error) {
      this.resources.releaseInternal(lease.id);
      throw error;
    }
    const id = randomUUID();
    const managed: ManagedSerial = {
      id, resourceId, port, baudRate, status: 'open', startedAt: new Date().toISOString(),
      bytesRead: 0, bufferedBytes: 0, ownerId: this.ownerId(), serial, leaseId: lease.id,
      buffer: Buffer.alloc(0), bufferBase: 0
    };
    const max = this.policy.config.process.maxOutputBytes;
    serial.on('data', (chunk: Buffer) => {
      managed.bytesRead += chunk.length;
      managed.buffer = Buffer.concat([managed.buffer, chunk]);
      if (managed.buffer.length > max) {
        const removed = managed.buffer.length - max;
        managed.buffer = managed.buffer.subarray(removed);
        managed.bufferBase += removed;
      }
      managed.bufferedBytes = managed.buffer.length;
    });
    serial.on('error', error => {
      managed.status = 'failed';
      managed.error = error.message;
    });
    serial.on('close', () => {
      if (managed.status !== 'failed') managed.status = 'closed';
      managed.endedAt ??= new Date().toISOString();
      this.resources.releaseInternal(managed.leaseId);
    });
    this.sessions.set(id, managed);
    return this.snapshot(managed);
  }

  read(id: string, cursor = 0): SerialReadResult {
    const managed = this.owned(id);
    const normalized = Math.max(0, Math.floor(cursor));
    const truncated = normalized < managed.bufferBase;
    const start = Math.max(normalized, managed.bufferBase) - managed.bufferBase;
    return {
      session: this.snapshot(managed),
      text: managed.buffer.subarray(start).toString('utf8'),
      nextCursor: managed.bufferBase + managed.buffer.length,
      truncated
    };
  }

  async waitForText(id: string, expectedText: string, timeoutMs = 10_000, cursor = 0): Promise<{
    matched: boolean;
    expectedText: string;
    text: string;
    nextCursor: number;
    elapsedMs: number;
    session: SerialSessionSnapshot;
  }> {
    const managed = this.owned(id);
    if (!expectedText || Buffer.byteLength(expectedText, 'utf8') > 4096) {
      throw new Error('expectedText must be 1..4096 UTF-8 bytes.');
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
      throw new Error('timeoutMs must be an integer in range 100..120000.');
    }

    const started = Date.now();
    let nextCursor = Math.max(0, Math.floor(cursor));
    let collected = '';
    while (Date.now() - started <= timeoutMs) {
      const chunk = this.read(id, nextCursor);
      nextCursor = chunk.nextCursor;
      collected += chunk.text;
      if (Buffer.byteLength(collected, 'utf8') > this.policy.config.process.maxOutputBytes) {
        collected = Buffer.from(collected, 'utf8').subarray(-this.policy.config.process.maxOutputBytes).toString('utf8');
      }
      if (collected.includes(expectedText)) {
        return {
          matched: true,
          expectedText,
          text: collected,
          nextCursor,
          elapsedMs: Date.now() - started,
          session: this.snapshot(managed)
        };
      }
      if (managed.status === 'failed' || managed.status === 'closed') break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return {
      matched: false,
      expectedText,
      text: collected,
      nextCursor,
      elapsedMs: Date.now() - started,
      session: this.snapshot(managed)
    };
  }

  async write(id: string, data: string, encoding: BufferEncoding = 'utf8'): Promise<{ acceptedBytes: number }> {
    this.policy.assertSerialWrite();
    const managed = this.owned(id);
    if (managed.status !== 'open' || !managed.serial.isOpen) throw new Error(`Serial session '${id}' is not open.`);
    const payload = Buffer.from(data, encoding);
    const max = this.policy.config.process.maxInputBytes ?? 64 * 1024;
    if (payload.length > max) throw new Error(`Serial write exceeds process.maxInputBytes (${max}).`);
    await new Promise<void>((resolve, reject) => managed.serial.write(payload, error => {
      if (error) return reject(error);
      managed.serial.drain(drainError => drainError ? reject(drainError) : resolve());
    }));
    return { acceptedBytes: payload.length };
  }

  async close(id: string): Promise<SerialSessionSnapshot> {
    const managed = this.owned(id);
    if (managed.serial.isOpen) {
      await new Promise<void>((resolve, reject) => managed.serial.close(error => error ? reject(error) : resolve()));
    }
    managed.status = managed.status === 'failed' ? 'failed' : 'closed';
    managed.endedAt ??= new Date().toISOString();
    this.resources.releaseInternal(managed.leaseId);
    return this.snapshot(managed);
  }

  list(): SerialSessionSnapshot[] {
    const owner = this.ownerId();
    return [...this.sessions.values()].filter(item => item.ownerId === owner).map(item => this.snapshot(item));
  }

  private snapshot(managed: ManagedSerial): SerialSessionSnapshot {
    const { ownerId: _owner, serial: _serial, leaseId: _lease, buffer: _buffer, bufferBase: _base, ...snapshot } = managed;
    return { ...snapshot };
  }
}
