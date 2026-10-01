import { fileURLToPath } from 'node:url';
import { PolicyEngine } from '../../policy.js';
import type { EngineeringCommandResult } from '../../engineering/types.js';
import { EngineeringCommandRunner } from './command-runner.js';
import { resolveFirstExecutable } from './executable-resolver.js';

export interface CanFilter {
  id: number;
  mask: number;
  extended?: boolean;
}

export interface CanCaptureOptions {
  count?: number;
  inactivityTimeoutMs?: number;
  filters?: CanFilter[];
  includeErrorFrames?: boolean;
}

interface IpLink {
  ifindex?: number;
  ifname?: string;
  flags?: string[];
  mtu?: number;
  qdisc?: string;
  operstate?: string;
  txqlen?: number;
  link_type?: string;
  linkinfo?: {
    info_kind?: string;
    info_data?: Record<string, unknown>;
  };
  stats64?: {
    rx?: Record<string, number>;
    tx?: Record<string, number>;
  };
}

function assertLinux(platform: NodeJS.Platform | string): void {
  if (platform !== 'linux') throw new Error('SocketCAN tooling is available on Linux hosts only.');
}

function interfaceName(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9_.:-]{1,15}$/.test(normalized)) {
    throw new Error('CAN interface name must be 1-15 characters using letters, digits, underscore, dot, colon or hyphen.');
  }
  return normalized;
}

function boundedInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

function boundedNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function boundedString(value: unknown, max = 128): string | undefined {
  return typeof value === 'string' && value.length <= max ? value : undefined;
}

function parseIpLinks(stdout: string): IpLink[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('ip link did not return valid JSON.');
  }
  if (!Array.isArray(parsed)) throw new Error('ip link JSON result was not an array.');
  return parsed.filter((entry): entry is IpLink => Boolean(entry && typeof entry === 'object')).slice(0, 256);
}

function canLinks(links: IpLink[]): IpLink[] {
  return links.filter(link => link.linkinfo?.info_kind === 'can' || link.linkinfo?.info_kind === 'vcan');
}

function sanitizeStats(stats: Record<string, number> | undefined): Record<string, number> | undefined {
  if (!stats) return undefined;
  const output: Record<string, number> = {};
  for (const [key, value] of Object.entries(stats).slice(0, 64)) {
    if (Number.isFinite(value)) output[key] = value;
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

function summarizeLink(link: IpLink) {
  const data = link.linkinfo?.info_data ?? {};
  const bitTiming = (data.bittiming && typeof data.bittiming === 'object') ? data.bittiming as Record<string, unknown> : {};
  const dataBitTiming = (data.data_bittiming && typeof data.data_bittiming === 'object') ? data.data_bittiming as Record<string, unknown> : {};
  const berr = (data.berr_counter && typeof data.berr_counter === 'object') ? data.berr_counter as Record<string, unknown> : {};
  return {
    ifindex: boundedInteger(link.ifindex),
    name: boundedString(link.ifname, 15),
    kind: link.linkinfo?.info_kind === 'vcan' ? 'vcan' as const : 'can' as const,
    adminUp: Boolean(link.flags?.includes('UP')),
    lowerUp: Boolean(link.flags?.includes('LOWER_UP')),
    operstate: boundedString(link.operstate),
    mtu: boundedInteger(link.mtu),
    txQueueLength: boundedInteger(link.txqlen),
    state: boundedString(data.state),
    restartMs: boundedInteger(data.restart_ms),
    bitrate: boundedInteger(bitTiming.bitrate ?? data.bitrate),
    samplePoint: boundedNumber(bitTiming.sample_point ?? data.sample_point),
    tq: boundedInteger(bitTiming.tq ?? data.tq),
    propSeg: boundedInteger(bitTiming.prop_seg ?? data.prop_seg),
    phaseSeg1: boundedInteger(bitTiming.phase_seg1 ?? data.phase_seg1),
    phaseSeg2: boundedInteger(bitTiming.phase_seg2 ?? data.phase_seg2),
    sjw: boundedInteger(bitTiming.sjw ?? data.sjw),
    dataBitrate: boundedInteger(dataBitTiming.bitrate ?? data.dbitrate),
    dataSamplePoint: boundedNumber(dataBitTiming.sample_point ?? data.dsample_point),
    termination: boundedInteger(data.termination),
    clockHz: boundedInteger((data.clock && typeof data.clock === 'object' ? (data.clock as Record<string, unknown>).freq : undefined) ?? data.clock),
    errorCounters: {
      tx: boundedInteger(berr.tx),
      rx: boundedInteger(berr.rx)
    },
    statistics: {
      rx: sanitizeStats(link.stats64?.rx),
      tx: sanitizeStats(link.stats64?.tx)
    }
  };
}

const CAN_EFF_FLAG = 0x80000000;

function validateFilter(filter: CanFilter): void {
  if (!Number.isSafeInteger(filter.id) || !Number.isSafeInteger(filter.mask) || filter.id < 0 || filter.mask < 0) {
    throw new Error('CAN filter id and mask must be non-negative integers.');
  }
  const max = filter.extended ? 0x1fffffff : 0x7ff;
  if (filter.id > max || filter.mask > max) {
    throw new Error(filter.extended
      ? 'Extended CAN filter id/mask must be <= 0x1FFFFFFF.'
      : 'Standard CAN filter id/mask must be <= 0x7FF.');
  }
}

function normalizeFilter(filter: CanFilter): string {
  validateFilter(filter);
  const idWidth = filter.extended ? 8 : 3;
  const idHex = filter.id.toString(16).toUpperCase().padStart(idWidth, '0');
  // candump sets CAN_EFF_FLAG from an 8-digit ID. Include that flag in the
  // mask as well so typed standard/extended filters do not cross-match formats.
  const formatExactMask = (filter.mask | CAN_EFF_FLAG) >>> 0;
  return `${idHex}:${formatExactMask.toString(16).toUpperCase().padStart(8, '0')}`;
}

function parseCandumpLine(line: string) {
  const match = line.trim().match(/^\((\d+(?:\.\d+)?)\)\s+([A-Za-z0-9_.:-]{1,15})\s+([0-9A-Fa-f]{3}|[0-9A-Fa-f]{8})(##?|#)(.*)$/);
  if (!match) return undefined;
  const [, timestampText, iface, idText, separator, payloadText] = match;
  const extended = idText.length === 8;
  const id = Number.parseInt(idText, 16);
  const payload = payloadText.trim();
  const fd = separator === '##';
  const rtrMatch = payload.match(/^R([0-8])?$/i);
  const isRtr = Boolean(rtrMatch);
  const fdFlags = fd && /^[0-9A-Fa-f]/.test(payload) ? Number.parseInt(payload.slice(0, 1), 16) : undefined;
  const dataText = fd ? payload.slice(1) : (isRtr ? '' : payload);
  const normalizedData = dataText.replace(/\s+/g, '').toUpperCase();
  const validData = /^[0-9A-F]*$/.test(normalizedData) && normalizedData.length % 2 === 0;
  const bytes = validData ? normalizedData.match(/.{2}/g) ?? [] : [];
  const error = (id & 0x20000000) !== 0;
  const normalizedId = id & (extended ? 0x1fffffff : 0x7ff);
  return {
    timestamp: Number(timestampText),
    interface: iface,
    id: normalizedId,
    idHex: normalizedId.toString(16).toUpperCase().padStart(extended ? 8 : 3, '0'),
    extended,
    fd,
    fdFlags,
    rtr: isRtr,
    error,
    dlc: isRtr ? Number(rtrMatch?.[1] ?? 0) : bytes.length,
    dataHex: validData ? normalizedData : '',
    data: bytes
  };
}

function captureSummary(frames: ReturnType<typeof parseCandumpLine>[]) {
  const valid = frames.filter((frame): frame is NonNullable<typeof frame> => Boolean(frame));
  const counts = new Map<string, { id: number; idHex: string; extended: boolean; frames: number; bytes: number }>();
  for (const frame of valid) {
    const key = `${frame.extended ? 'E' : 'S'}:${frame.idHex}`;
    const current = counts.get(key) ?? { id: frame.id, idHex: frame.idHex, extended: frame.extended, frames: 0, bytes: 0 };
    current.frames += 1;
    current.bytes += frame.data.length;
    counts.set(key, current);
  }
  const timestamps = valid.map(frame => frame.timestamp).filter(Number.isFinite);
  const first = timestamps.length ? Math.min(...timestamps) : undefined;
  const last = timestamps.length ? Math.max(...timestamps) : undefined;
  const durationSeconds = first !== undefined && last !== undefined && last >= first ? last - first : undefined;
  return {
    frameCount: valid.length,
    dataFrameCount: valid.filter(frame => !frame.error).length,
    errorFrameCount: valid.filter(frame => frame.error).length,
    fdFrameCount: valid.filter(frame => frame.fd).length,
    rtrFrameCount: valid.filter(frame => frame.rtr).length,
    uniqueIdCount: counts.size,
    firstTimestamp: first,
    lastTimestamp: last,
    durationSeconds,
    observedFramesPerSecond: durationSeconds && durationSeconds > 0 ? valid.length / durationSeconds : undefined,
    ids: [...counts.values()].sort((a, b) => b.frames - a.frames || a.id - b.id).slice(0, 256)
  };
}

const PYTHON_CAPTURE_HELPER = fileURLToPath(new URL('../../../scripts/socketcan_capture.py', import.meta.url));

function pythonFilter(filter: CanFilter): string {
  validateFilter(filter);
  const width = filter.extended ? 8 : 3;
  const id = filter.id.toString(16).toUpperCase().padStart(width, '0');
  const mask = filter.mask.toString(16).toUpperCase().padStart(width, '0');
  return `${id}:${mask}:${filter.extended ? '1' : '0'}`;
}

function succeeded(result: EngineeringCommandResult): boolean {
  return !result.timedOut && result.exitCode === 0;
}

export class CanAdapter {
  constructor(
    private readonly policy: PolicyEngine,
    private readonly runner: EngineeringCommandRunner,
    private readonly platform: NodeJS.Platform | string = process.platform
  ) {}

  private async ipExecutable(): Promise<string> {
    const resolved = await resolveFirstExecutable(['ip']);
    if (!resolved) throw new Error('iproute2 ip executable is unavailable.');
    return resolved.path;
  }

  private async candumpExecutable(): Promise<string | undefined> {
    return (await resolveFirstExecutable(['candump']))?.path;
  }

  private async pythonExecutable(): Promise<string | undefined> {
    return (await resolveFirstExecutable(['python3']))?.path;
  }

  async providerStatus() {
    if (this.platform !== 'linux') {
      return { supported: false, platform: this.platform, socketcan: false, iproute2: false, candump: false, capture: false };
    }
    const [ip, candump, python3] = await Promise.all([resolveFirstExecutable(['ip']), resolveFirstExecutable(['candump']), resolveFirstExecutable(['python3'])]);
    let candumpVersion: string | undefined;
    if (candump) {
      const version = await this.runner.run(candump.path, ['-h'], process.cwd(), 5_000);
      candumpVersion = (version.stderr || version.stdout).split(/\r?\n/).find(line => /candump/i.test(line))?.trim();
    }
    return {
      supported: Boolean(ip),
      platform: this.platform,
      socketcan: Boolean(ip),
      iproute2: Boolean(ip),
      candump: Boolean(candump),
      capture: Boolean(ip && (candump || python3)),
      captureBackend: candump ? 'candump' : python3 ? 'python-af-can' : 'unavailable',
      candumpVersion,
      pythonFallback: Boolean(python3),
      authority: 'read-only',
      unavailable: ['interface configuration', 'bitrate mutation', 'frame transmission', 'bus-off restart', 'gateway mutation', 'log replay']
    };
  }

  async listInterfaces() {
    this.policy.assertEngineeringExecute();
    assertLinux(this.platform);
    const ip = await this.ipExecutable();
    const result = await this.runner.run(ip, ['-json', '-details', '-statistics', 'link', 'show'], process.cwd(), 10_000);
    if (!succeeded(result)) throw new Error(`CAN interface discovery failed: ${result.stderr || result.stdout || `exit=${result.exitCode}`}`);
    return canLinks(parseIpLinks(result.stdout)).map(summarizeLink).filter(item => item.name);
  }

  async interfaceStatus(name: string) {
    this.policy.assertEngineeringExecute();
    assertLinux(this.platform);
    const selected = interfaceName(name);
    const ip = await this.ipExecutable();
    const result = await this.runner.run(ip, ['-json', '-details', '-statistics', 'link', 'show', 'dev', selected], process.cwd(), 10_000);
    if (!succeeded(result)) throw new Error(`CAN interface status failed: ${result.stderr || result.stdout || `exit=${result.exitCode}`}`);
    const found = canLinks(parseIpLinks(result.stdout)).find(link => link.ifname === selected);
    if (!found) throw new Error(`Interface '${selected}' is not a SocketCAN CAN/vcan interface.`);
    return summarizeLink(found);
  }

  async capture(name: string, options: CanCaptureOptions = {}) {
    this.policy.assertEngineeringExecute();
    assertLinux(this.platform);
    const selected = interfaceName(name);
    const count = options.count ?? 100;
    const inactivityTimeoutMs = options.inactivityTimeoutMs ?? 2_000;
    if (!Number.isSafeInteger(count) || count < 1 || count > 1_000) throw new Error('CAN capture count must be between 1 and 1000 frames.');
    if (!Number.isSafeInteger(inactivityTimeoutMs) || inactivityTimeoutMs < 100 || inactivityTimeoutMs > 30_000) {
      throw new Error('CAN capture inactivityTimeoutMs must be between 100 and 30000.');
    }
    const filters = (options.filters ?? []).slice(0, 32);
    if ((options.filters?.length ?? 0) > 32) throw new Error('CAN capture accepts at most 32 filters.');
    const interfaceSpec = [
      selected,
      ...filters.map(normalizeFilter),
      ...(options.includeErrorFrames ? ['#1FFFFFFF'] : [])
    ].join(',');
    const candump = await this.candumpExecutable();
    const python3 = candump ? undefined : await this.pythonExecutable();
    if (!candump && !python3) throw new Error('CAN capture requires either linux-can candump or python3 with AF_CAN support.');
    const backend = candump ? 'candump' as const : 'python-af-can' as const;
    const result = candump
      ? await this.runner.run(
          candump,
          ['-L', '-n', String(count), '-T', String(inactivityTimeoutMs), interfaceSpec],
          process.cwd(),
          Math.min(35_000, inactivityTimeoutMs + 5_000)
        )
      : await this.runner.run(
          python3!,
          [
            PYTHON_CAPTURE_HELPER,
            '--interface', selected,
            '--count', String(count),
            '--timeout-ms', String(inactivityTimeoutMs),
            ...filters.flatMap(filter => ['--filter', pythonFilter(filter)]),
            ...(options.includeErrorFrames ? ['--errors'] : [])
          ],
          process.cwd(),
          Math.min(35_000, inactivityTimeoutMs + 5_000)
        );
    if (!succeeded(result)) throw new Error(`CAN capture failed: ${result.stderr || result.stdout || `exit=${result.exitCode}`}`);
    const lines = result.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(0, 1_000);
    const frames = lines.map(parseCandumpLine).filter((frame): frame is NonNullable<typeof frame> => Boolean(frame));
    return {
      interface: selected,
      backend,
      requestedCount: count,
      inactivityTimeoutMs,
      filters,
      includeErrorFrames: Boolean(options.includeErrorFrames),
      frames,
      summary: captureSummary(frames),
      warnings: frames.length < lines.length ? [`Ignored ${lines.length - frames.length} unrecognized candump line(s).`] : []
    };
  }
}
