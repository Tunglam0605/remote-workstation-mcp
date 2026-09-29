import net from 'node:net';
import tls from 'node:tls';
import { randomBytes } from 'node:crypto';
import type { ResolvedMqttProfile } from './profile-store.js';

export interface MqttSampleOptions {
  maxMessages?: number;
  timeoutMs?: number;
  maxPayloadBytes?: number;
}

export interface MqttSampleMessage {
  topic: string;
  qos: number;
  retained: boolean;
  duplicate: boolean;
  bytes: number;
  payloadText?: string;
  json?: unknown;
}

export type ParsedPacket = { type: number; flags: number; payload: Buffer };

function encodeRemainingLength(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0 || value > 268_435_455) throw new Error('MQTT remaining length is out of range.');
  const bytes: number[] = [];
  let current = value;
  do {
    let digit = current % 128;
    current = Math.floor(current / 128);
    if (current > 0) digit |= 0x80;
    bytes.push(digit);
  } while (current > 0);
  return Buffer.from(bytes);
}

function utf8(value: string): Buffer {
  const body = Buffer.from(value, 'utf8');
  if (body.length > 65_535) throw new Error('MQTT UTF-8 field exceeds 65535 bytes.');
  const prefix = Buffer.allocUnsafe(2);
  prefix.writeUInt16BE(body.length, 0);
  return Buffer.concat([prefix, body]);
}

export function encodeConnectPacket(profile: Pick<ResolvedMqttProfile, 'username' | 'password'>, clientId: string): Buffer {
  let flags = 0x02; // Clean Session.
  if (profile.username) flags |= 0x80;
  if (profile.password) flags |= 0x40;
  if (profile.password && !profile.username) throw new Error('MQTT password requires username.');
  const variable = Buffer.concat([
    utf8('MQTT'),
    Buffer.from([0x04, flags, 0x00, 0x3c]) // MQTT 3.1.1, keepalive=60 s; longer than the bounded 30 s sampling window.
  ]);
  const payload = Buffer.concat([
    utf8(clientId),
    ...(profile.username ? [utf8(profile.username)] : []),
    ...(profile.password ? [utf8(profile.password)] : [])
  ]);
  const remaining = variable.length + payload.length;
  return Buffer.concat([Buffer.from([0x10]), encodeRemainingLength(remaining), variable, payload]);
}

export function encodeSubscribePacket(topicFilter: string, packetId = 1): Buffer {
  validateTopicFilter(topicFilter);
  if (!Number.isInteger(packetId) || packetId < 1 || packetId > 65_535) throw new Error('MQTT packet identifier must be 1..65535.');
  const id = Buffer.allocUnsafe(2);
  id.writeUInt16BE(packetId, 0);
  const body = Buffer.concat([id, utf8(topicFilter), Buffer.from([0x00])]); // Max QoS 0.
  return Buffer.concat([Buffer.from([0x82]), encodeRemainingLength(body.length), body]);
}

export function validateTopicFilter(value: string): string {
  const topic = value.trim();
  if (!topic || topic.length > 512 || topic.includes('\0')) throw new Error('MQTT topic filter must contain 1..512 non-null characters.');
  const encoded = Buffer.byteLength(topic, 'utf8');
  if (encoded > 65_535) throw new Error('MQTT topic filter exceeds protocol UTF-8 limit.');
  const levels = topic.split('/');
  for (let i = 0; i < levels.length; i += 1) {
    const level = levels[i]!;
    if (level.includes('#') && (level !== '#' || i !== levels.length - 1)) {
      throw new Error("MQTT '#' wildcard must occupy the final topic level.");
    }
    if (level.includes('+') && level !== '+') {
      throw new Error("MQTT '+' wildcard must occupy an entire topic level.");
    }
  }
  return topic;
}

export function parsePublishPacket(packet: ParsedPacket, maxPayloadBytes: number): MqttSampleMessage | undefined {
  if (packet.type !== 3) return undefined;
  if (packet.payload.length < 2) throw new Error('Malformed MQTT PUBLISH packet.');
  const topicLength = packet.payload.readUInt16BE(0);
  if (topicLength < 1 || 2 + topicLength > packet.payload.length) throw new Error('Malformed MQTT PUBLISH topic.');
  const topic = packet.payload.subarray(2, 2 + topicLength).toString('utf8');
  let offset = 2 + topicLength;
  const qos = (packet.flags >> 1) & 0x03;
  if (qos === 3) throw new Error('Malformed MQTT PUBLISH QoS.');
  if (qos > 0) {
    if (offset + 2 > packet.payload.length) throw new Error('Malformed MQTT PUBLISH packet identifier.');
    offset += 2;
  }
  const payload = packet.payload.subarray(offset);
  if (payload.length > maxPayloadBytes) throw new Error('MQTT PUBLISH payload exceeds configured bound.');
  let payloadText: string | undefined;
  let json: unknown;
  try {
    payloadText = new TextDecoder('utf-8', { fatal: true }).decode(payload);
    if (payloadText.length > 32_768) payloadText = payloadText.slice(0, 32_768);
    try { json = JSON.parse(payloadText); } catch { /* text payload is still valid */ }
  } catch {
    payloadText = undefined;
  }
  return {
    topic,
    qos,
    retained: Boolean(packet.flags & 0x01),
    duplicate: Boolean(packet.flags & 0x08),
    bytes: payload.length,
    ...(payloadText !== undefined ? { payloadText } : {}),
    ...(json !== undefined ? { json } : {})
  };
}

class PacketReader {
  private buffer = Buffer.alloc(0);
  private readonly packets: ParsedPacket[] = [];
  private readonly waiters: Array<{ resolve: (packet: ParsedPacket) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];
  private failed?: Error;

  constructor(private readonly maxPacketBytes = 512 * 1024) {}

  push(chunk: Buffer): void {
    if (this.failed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > this.maxPacketBytes * 2) return this.fail(new Error('MQTT receive buffer exceeded safety bound.'));
    try {
      while (true) {
        const packet = this.extract();
        if (!packet) break;
        const waiter = this.waiters.shift();
        if (waiter) {
          clearTimeout(waiter.timer);
          waiter.resolve(packet);
        } else {
          this.packets.push(packet);
        }
      }
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  fail(error: Error): void {
    if (this.failed) return;
    this.failed = error;
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  private extract(): ParsedPacket | undefined {
    if (this.buffer.length < 2) return undefined;
    const first = this.buffer[0]!;
    let multiplier = 1;
    let remaining = 0;
    let index = 1;
    let bytes = 0;
    while (true) {
      if (index >= this.buffer.length) return undefined;
      const digit = this.buffer[index++]!;
      bytes += 1;
      remaining += (digit & 0x7f) * multiplier;
      if (multiplier > 128 * 128 * 128) throw new Error('Malformed MQTT remaining length.');
      if ((digit & 0x80) === 0) break;
      multiplier *= 128;
      if (bytes >= 4) throw new Error('Malformed MQTT remaining length.');
    }
    if (remaining > this.maxPacketBytes) throw new Error('MQTT packet exceeds safety bound.');
    const total = index + remaining;
    if (this.buffer.length < total) return undefined;
    const payload = this.buffer.subarray(index, total);
    this.buffer = this.buffer.subarray(total);
    return { type: first >> 4, flags: first & 0x0f, payload };
  }

  async next(timeoutMs: number): Promise<ParsedPacket> {
    if (this.failed) throw this.failed;
    const queued = this.packets.shift();
    if (queued) return queued;
    return await new Promise<ParsedPacket>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex(item => item.resolve === resolve);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Error('MQTT packet wait timed out.'));
      }, timeoutMs);
      this.waiters.push({ resolve, reject, timer });
    });
  }
}

async function connectSocket(profile: ResolvedMqttProfile, timeoutMs: number): Promise<net.Socket> {
  return await new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      clearTimeout(timer);
      reject(error);
    };
    const socket: net.Socket = profile.tls
      ? tls.connect({
          host: profile.host,
          port: profile.port,
          rejectUnauthorized: true,
          servername: profile.servername ?? (net.isIP(profile.host) ? undefined : profile.host)
        })
      : net.createConnection({ host: profile.host, port: profile.port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('MQTT broker connection timed out.'));
    }, timeoutMs);
    socket.once('error', onError);
    socket.once(profile.tls ? 'secureConnect' : 'connect', () => {
      clearTimeout(timer);
      socket.off('error', onError);
      socket.setNoDelay(true);
      resolve(socket);
    });
  });
}

function clientId(): string {
  return ('rwmcp-' + process.pid.toString(36) + '-' + randomBytes(5).toString('hex')).slice(0, 23);
}

export class MqttDiagnosticClient {
  async sample(profile: ResolvedMqttProfile, topicFilter: string, options: MqttSampleOptions = {}) {
    const topic = validateTopicFilter(topicFilter);
    const maxMessages = options.maxMessages ?? 10;
    const timeoutMs = options.timeoutMs ?? 5_000;
    const maxPayloadBytes = options.maxPayloadBytes ?? 64 * 1024;
    if (!Number.isInteger(maxMessages) || maxMessages < 1 || maxMessages > 100) throw new Error('maxMessages must be between 1 and 100.');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 30_000) throw new Error('timeoutMs must be between 250 and 30000.');
    if (!Number.isInteger(maxPayloadBytes) || maxPayloadBytes < 256 || maxPayloadBytes > 256 * 1024) throw new Error('maxPayloadBytes must be between 256 and 262144.');

    const socket = await connectSocket(profile, Math.min(timeoutMs, 5_000));
    const reader = new PacketReader(Math.max(512 * 1024, maxPayloadBytes + 16 * 1024));
    socket.on('data', chunk => reader.push(Buffer.from(chunk)));
    socket.on('error', error => reader.fail(error));
    socket.on('close', () => reader.fail(new Error('MQTT broker closed the connection.')));

    const startedAt = Date.now();
    const messages: MqttSampleMessage[] = [];
    try {
      socket.write(encodeConnectPacket(profile, clientId()));
      const connack = await reader.next(Math.min(timeoutMs, 5_000));
      if (connack.type !== 2 || connack.payload.length !== 2) throw new Error('Expected MQTT CONNACK.');
      if (connack.payload[1] !== 0) throw new Error(`MQTT broker rejected CONNECT with return code ${connack.payload[1]}.`);

      socket.write(encodeSubscribePacket(topic, 1));
      const suback = await reader.next(Math.min(timeoutMs, 5_000));
      if (suback.type !== 9 || suback.payload.length < 3 || suback.payload.readUInt16BE(0) !== 1) throw new Error('Expected MQTT SUBACK for packet 1.');
      if (suback.payload[2] === 0x80) throw new Error('MQTT broker rejected the subscription.');

      while (messages.length < maxMessages) {
        const remaining = timeoutMs - (Date.now() - startedAt);
        if (remaining <= 0) break;
        let packet: ParsedPacket;
        try {
          packet = await reader.next(remaining);
        } catch (error) {
          if (error instanceof Error && /timed out/.test(error.message)) break;
          throw error;
        }
        const publish = parsePublishPacket(packet, maxPayloadBytes);
        if (publish) messages.push(publish);
      }

      return {
        profileId: profile.id,
        broker: { host: profile.host, port: profile.port, tls: profile.tls },
        topicFilter: topic,
        requestedMaxMessages: maxMessages,
        timeoutMs,
        messageCount: messages.length,
        messages,
        timedOut: messages.length < maxMessages
      };
    } finally {
      try { socket.write(Buffer.from([0xe0, 0x00])); } catch { /* ignore */ }
      socket.destroy();
    }
  }
}
