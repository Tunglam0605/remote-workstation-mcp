import type { CanAdapter } from '../../adapters/engineering/can.js';

type PdoKind = 'tpdo1' | 'rpdo1' | 'tpdo2' | 'rpdo2' | 'tpdo3' | 'rpdo3' | 'tpdo4' | 'rpdo4';

type CapturedCanFrame = {
  timestamp: number;
  interface: string;
  id: number;
  idHex: string;
  extended: boolean;
  fd: boolean;
  rtr: boolean;
  error: boolean;
  dlc: number;
  dataHex: string;
  data: string[];
};

export type CanopenFrameKind =
  | 'nmt'
  | 'sync'
  | 'emcy'
  | 'time'
  | 'tpdo1'
  | 'rpdo1'
  | 'tpdo2'
  | 'rpdo2'
  | 'tpdo3'
  | 'rpdo3'
  | 'tpdo4'
  | 'rpdo4'
  | 'sdo-response'
  | 'sdo-request'
  | 'heartbeat';

const NMT_COMMANDS: Record<number, string> = {
  0x01: 'start',
  0x02: 'stop',
  0x80: 'pre-operational',
  0x81: 'reset-node',
  0x82: 'reset-communication'
};

const NMT_STATES: Record<number, string> = {
  0x00: 'boot-up',
  0x04: 'stopped',
  0x05: 'operational',
  0x7f: 'pre-operational'
};

function byte(value: string | undefined): number | undefined {
  if (!value || !/^[0-9A-Fa-f]{2}$/.test(value)) return undefined;
  return Number.parseInt(value, 16);
}

function le16(data: string[], offset: number): number | undefined {
  const lo = byte(data[offset]);
  const hi = byte(data[offset + 1]);
  return lo === undefined || hi === undefined ? undefined : lo | (hi << 8);
}

function le32(data: string[], offset: number): number | undefined {
  const b0 = byte(data[offset]);
  const b1 = byte(data[offset + 1]);
  const b2 = byte(data[offset + 2]);
  const b3 = byte(data[offset + 3]);
  if ([b0, b1, b2, b3].some(value => value === undefined)) return undefined;
  return ((b0! | (b1! << 8) | (b2! << 16) | (b3! << 24)) >>> 0);
}

function objectAddress(data: string[]) {
  const index = le16(data, 1);
  const subIndex = byte(data[3]);
  return index === undefined || subIndex === undefined
    ? undefined
    : { index, indexHex: `0x${index.toString(16).toUpperCase().padStart(4, '0')}`, subIndex };
}

function pdoRange(id: number): { kind: PdoKind; nodeId: number } | undefined {
  const ranges: Array<[number, number, PdoKind]> = [
    [0x180, 0x1ff, 'tpdo1'],
    [0x200, 0x27f, 'rpdo1'],
    [0x280, 0x2ff, 'tpdo2'],
    [0x300, 0x37f, 'rpdo2'],
    [0x380, 0x3ff, 'tpdo3'],
    [0x400, 0x47f, 'rpdo3'],
    [0x480, 0x4ff, 'tpdo4'],
    [0x500, 0x57f, 'rpdo4']
  ];
  for (const [base, end, kind] of ranges) {
    if (id > base && id <= end) return { kind, nodeId: id - base };
  }
  return undefined;
}

export function decodeCanopenFrame(frame: CapturedCanFrame) {
  if (frame.extended || frame.fd || frame.rtr || frame.error || frame.id < 0 || frame.id > 0x7ff) return undefined;
  const common = {
    timestamp: frame.timestamp,
    interface: frame.interface,
    cobId: frame.id,
    cobIdHex: `0x${frame.id.toString(16).toUpperCase().padStart(3, '0')}`,
    dlc: frame.dlc,
    dataHex: frame.dataHex
  };

  if (frame.id === 0x000) {
    const command = byte(frame.data[0]);
    const targetNodeId = byte(frame.data[1]);
    return {
      ...common,
      kind: 'nmt' as const,
      command,
      commandName: command === undefined ? 'unknown' : NMT_COMMANDS[command] ?? 'unknown',
      targetNodeId
    };
  }

  if (frame.id === 0x080) return { ...common, kind: 'sync' as const };
  if (frame.id === 0x100) return { ...common, kind: 'time' as const };

  if (frame.id >= 0x081 && frame.id <= 0x0ff) {
    const errorCode = le16(frame.data, 0);
    const errorRegister = byte(frame.data[2]);
    return {
      ...common,
      kind: 'emcy' as const,
      nodeId: frame.id - 0x080,
      errorCode,
      ...(errorCode !== undefined ? { errorCodeHex: `0x${errorCode.toString(16).toUpperCase().padStart(4, '0')}` } : {}),
      errorRegister,
      manufacturerDataHex: frame.data.slice(3, 8).join('')
    };
  }

  const pdo = pdoRange(frame.id);
  if (pdo) return { ...common, ...pdo };

  if (frame.id >= 0x581 && frame.id <= 0x5ff) {
    const commandSpecifier = byte(frame.data[0]);
    const address = objectAddress(frame.data);
    const abortCode = commandSpecifier === 0x80 ? le32(frame.data, 4) : undefined;
    return {
      ...common,
      kind: 'sdo-response' as const,
      nodeId: frame.id - 0x580,
      commandSpecifier,
      ...(address ? { object: address } : {}),
      ...(abortCode !== undefined ? {
        abortCode,
        abortCodeHex: `0x${abortCode.toString(16).toUpperCase().padStart(8, '0')}`
      } : {})
    };
  }

  if (frame.id >= 0x601 && frame.id <= 0x67f) {
    const commandSpecifier = byte(frame.data[0]);
    const address = objectAddress(frame.data);
    return {
      ...common,
      kind: 'sdo-request' as const,
      nodeId: frame.id - 0x600,
      commandSpecifier,
      ...(address ? { object: address } : {})
    };
  }

  if (frame.id >= 0x701 && frame.id <= 0x77f) {
    const state = byte(frame.data[0]);
    return {
      ...common,
      kind: 'heartbeat' as const,
      nodeId: frame.id - 0x700,
      state,
      stateName: state === undefined ? 'unknown' : NMT_STATES[state] ?? 'unknown'
    };
  }

  return undefined;
}

function summarizeKinds(frames: Array<NonNullable<ReturnType<typeof decodeCanopenFrame>>>) {
  const counts: Record<string, number> = {};
  for (const frame of frames) counts[frame.kind] = (counts[frame.kind] ?? 0) + 1;
  return counts;
}

function meanInterval(timestamps: number[]): number | undefined {
  if (timestamps.length < 2) return undefined;
  const sorted = [...timestamps].sort((a, b) => a - b);
  let total = 0;
  for (let i = 1; i < sorted.length; i += 1) total += sorted[i]! - sorted[i - 1]!;
  return total / (sorted.length - 1);
}

export class CanopenAdapter {
  constructor(private readonly can: CanAdapter) {}

  async providerStatus() {
    const can = await this.can.providerStatus();
    const supported = Boolean(can.supported && can.capture);
    return {
      supported,
      profile: 'CiA 301 passive diagnostics',
      transport: 'SocketCAN',
      captureBackend: can.captureBackend,
      authority: 'read-only-passive',
      availableObjects: ['NMT observation', 'SYNC observation', 'EMCY decode', 'PDO classification', 'SDO observation', 'Heartbeat/NMT-state observation'],
      intentionallyUnavailable: ['CAN frame transmission', 'NMT command transmission', 'SDO upload/download initiation', 'PDO transmission', 'LSS', 'node guarding requests', 'bus configuration'],
      baseCan: can
    };
  }

  async captureDecode(interfaceName: string, options: { count?: number; inactivityTimeoutMs?: number; nodeIds?: number[] } = {}) {
    const capture = await this.can.capture(interfaceName, {
      count: options.count ?? 250,
      inactivityTimeoutMs: options.inactivityTimeoutMs ?? 3_000,
      includeErrorFrames: false
    });
    const requestedNodes = new Set(options.nodeIds ?? []);
    const decoded = (capture.frames as CapturedCanFrame[])
      .map(decodeCanopenFrame)
      .filter((frame): frame is NonNullable<ReturnType<typeof decodeCanopenFrame>> => Boolean(frame))
      .filter(frame => {
        if (!requestedNodes.size) return true;
        if (!('nodeId' in frame)) return frame.kind === 'nmt' || frame.kind === 'sync' || frame.kind === 'time';
        return requestedNodes.has(frame.nodeId);
      });
    return {
      interface: capture.interface,
      backend: capture.backend,
      requestedCount: capture.requestedCount,
      inactivityTimeoutMs: capture.inactivityTimeoutMs,
      nodeIds: [...requestedNodes].sort((a, b) => a - b),
      capturedFrameCount: capture.frames.length,
      decodedFrameCount: decoded.length,
      ignoredFrameCount: capture.frames.length - decoded.length,
      kinds: summarizeKinds(decoded),
      frames: decoded,
      warnings: capture.warnings
    };
  }

  async observeNodes(interfaceName: string, options: { count?: number; inactivityTimeoutMs?: number; nodeIds?: number[] } = {}) {
    const sample = await this.captureDecode(interfaceName, options);
    const requested = new Set(options.nodeIds ?? []);
    const observed = new Set<number>();
    for (const frame of sample.frames) {
      if ('nodeId' in frame && Number.isInteger(frame.nodeId) && frame.nodeId >= 1 && frame.nodeId <= 127) observed.add(frame.nodeId);
      if (frame.kind === 'nmt' && 'targetNodeId' in frame && frame.targetNodeId && frame.targetNodeId >= 1 && frame.targetNodeId <= 127) observed.add(frame.targetNodeId);
    }
    const nodeIds = (requested.size ? [...requested] : [...observed]).sort((a, b) => a - b).slice(0, 32);

    const nodes = nodeIds.map(nodeId => {
      const nodeFrames = sample.frames.filter(frame =>
        ('nodeId' in frame && frame.nodeId === nodeId) ||
        (frame.kind === 'nmt' && 'targetNodeId' in frame && (frame.targetNodeId === 0 || frame.targetNodeId === nodeId))
      );
      const heartbeats = nodeFrames.filter(frame => frame.kind === 'heartbeat');
      const emcy = nodeFrames.filter(frame => frame.kind === 'emcy');
      const lastHeartbeat = heartbeats.at(-1);
      const heartbeatTimestamps = heartbeats.map(frame => frame.timestamp).filter(Number.isFinite);
      const meanHeartbeatSeconds = meanInterval(heartbeatTimestamps);
      return {
        nodeId,
        observed: nodeFrames.length > 0,
        frameCount: nodeFrames.length,
        heartbeatCount: heartbeats.length,
        bootUpObserved: heartbeats.some(frame => 'state' in frame && frame.state === 0),
        ...(lastHeartbeat && 'stateName' in lastHeartbeat ? {
          lastNmtState: lastHeartbeat.stateName,
          lastHeartbeatTimestamp: lastHeartbeat.timestamp
        } : {}),
        ...(meanHeartbeatSeconds !== undefined ? { meanHeartbeatIntervalMs: Math.round(meanHeartbeatSeconds * 1_000_000) / 1_000 } : {}),
        emcyCount: emcy.length,
        latestEmcy: emcy.at(-1),
        sdoRequestCount: nodeFrames.filter(frame => frame.kind === 'sdo-request').length,
        sdoResponseCount: nodeFrames.filter(frame => frame.kind === 'sdo-response').length,
        tpdoCount: nodeFrames.filter(frame => /^tpdo/.test(frame.kind)).length,
        rpdoCount: nodeFrames.filter(frame => /^rpdo/.test(frame.kind)).length
      };
    });

    return {
      interface: sample.interface,
      backend: sample.backend,
      passiveDiscovery: requested.size === 0,
      requestedNodeIds: [...requested].sort((a, b) => a - b),
      observedNodeIds: [...observed].sort((a, b) => a - b).slice(0, 127),
      nodes,
      sample: {
        capturedFrameCount: sample.capturedFrameCount,
        decodedFrameCount: sample.decodedFrameCount,
        kinds: sample.kinds,
        inactivityTimeoutMs: sample.inactivityTimeoutMs
      }
    };
  }
}
