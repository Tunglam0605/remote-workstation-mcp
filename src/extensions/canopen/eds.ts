import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveExistingProjectPath } from '../../adapters/engineering/project-path.js';
import type { PathGuard } from '../../security/path-guard.js';

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_LINES = 30_000;
const MAX_SECTIONS = 4_096;
const MAX_ENTRIES = 4_096;
const MAX_WARNINGS = 64;
const MAX_VALUE_CHARS = 256;
const MAX_METADATA_FIELDS = 128;

const FIELD_MAP = new Map<string, string>([
  ['parametername', 'parameterName'],
  ['objecttype', 'objectType'],
  ['datatype', 'dataType'],
  ['accesstype', 'accessType'],
  ['defaultvalue', 'defaultValue'],
  ['parametervalue', 'parameterValue'],
  ['pdomapping', 'pdoMapping'],
  ['lowlimit', 'lowLimit'],
  ['highlimit', 'highLimit'],
  ['unit', 'unit'],
  ['subnumber', 'subNumber']
]);

export type OdContainer = {
  index: number;
  indexHex: string;
  parameterName?: string;
  objectType?: string;
  subNumber?: number;
};

export type OdEntry = {
  index: number;
  indexHex: string;
  subIndex: number;
  parameterName?: string;
  objectType?: string;
  dataType?: string;
  accessType?: string;
  defaultValue?: string;
  parameterValue?: string;
  pdoMapping?: string;
  lowLimit?: string;
  highLimit?: string;
  unit?: string;
  parent?: OdContainer;
};

type RawSection = {
  index: number;
  indexHex: string;
  explicitSubIndex?: number;
  name: string;
  values: Record<string, string>;
};

export type EdsMetadata = {
  fileInfo: Record<string, string>;
  deviceInfo: Record<string, string>;
  deviceComissioning: Record<string, string>;
};

export type RawCanopenFrame = {
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

type DecodedCanopenFrame = {
  kind: string;
  commandSpecifier?: number;
  object?: { index: number; subIndex: number };
  [key: string]: unknown;
};

function staticUnsigned(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (!value) return undefined;
  let parsed: number;
  if (/^0x[0-9a-f]+$/i.test(value)) parsed = Number.parseInt(value.slice(2), 16);
  else if (/^[0-9a-f]+h$/i.test(value)) parsed = Number.parseInt(value.slice(0, -1), 16);
  else if (/^[0-9]+$/.test(value)) parsed = Number.parseInt(value, 10);
  else return undefined;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export function resolveEdsUnsigned(raw: string | undefined, nodeId?: number): number | undefined {
  const direct = staticUnsigned(raw);
  if (direct !== undefined) return direct;
  if (raw === undefined || nodeId === undefined || !Number.isInteger(nodeId) || nodeId < 1 || nodeId > 127) return undefined;

  const match = /^\$NODEID(?:\s*([+-])\s*(0x[0-9a-f]+|[0-9a-f]+h|[0-9]+))?$/i.exec(raw.trim());
  if (!match) return undefined;
  const offset = match[2] === undefined ? 0 : staticUnsigned(match[2]);
  if (offset === undefined) return undefined;
  const value = match[1] === '-' ? nodeId - offset : nodeId + offset;
  return Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff ? value : undefined;
}

function entryRawValue(entry: OdEntry | undefined): string | undefined {
  return entry?.parameterValue ?? entry?.defaultValue;
}

function boundedValue(raw: string): string {
  const comment = raw.indexOf(';');
  return (comment >= 0 ? raw.slice(0, comment) : raw).trim().slice(0, MAX_VALUE_CHARS);
}

function containerFrom(section: RawSection, warnings: string[]): OdContainer {
  const subNumberRaw = section.values.subNumber;
  const subNumber = staticUnsigned(subNumberRaw);
  if (subNumberRaw !== undefined && (subNumber === undefined || subNumber > 0xff) && warnings.length < MAX_WARNINGS) {
    warnings.push(`Ignored invalid SubNumber in [${section.name}].`);
  }
  return {
    index: section.index,
    indexHex: section.indexHex,
    ...(section.values.parameterName ? { parameterName: section.values.parameterName } : {}),
    ...(section.values.objectType ? { objectType: section.values.objectType } : {}),
    ...(subNumber !== undefined && subNumber <= 0xff ? { subNumber } : {})
  };
}

function entryFrom(section: RawSection, subIndex: number, parent?: OdContainer): OdEntry {
  return {
    index: section.index,
    indexHex: section.indexHex,
    subIndex,
    ...(section.values.parameterName ? { parameterName: section.values.parameterName } : {}),
    ...(section.values.objectType ? { objectType: section.values.objectType } : {}),
    ...(section.values.dataType ? { dataType: section.values.dataType } : {}),
    ...(section.values.accessType ? { accessType: section.values.accessType } : {}),
    ...(section.values.defaultValue !== undefined ? { defaultValue: section.values.defaultValue } : {}),
    ...(section.values.parameterValue !== undefined ? { parameterValue: section.values.parameterValue } : {}),
    ...(section.values.pdoMapping !== undefined ? { pdoMapping: section.values.pdoMapping } : {}),
    ...(section.values.lowLimit !== undefined ? { lowLimit: section.values.lowLimit } : {}),
    ...(section.values.highLimit !== undefined ? { highLimit: section.values.highLimit } : {}),
    ...(section.values.unit !== undefined ? { unit: section.values.unit } : {}),
    ...(parent ? { parent } : {})
  };
}

export class ObjectDictionary {
  private readonly entryMap = new Map<string, OdEntry>();
  private readonly containerMap = new Map<number, OdContainer>();

  constructor(
    readonly entries: OdEntry[],
    readonly containers: OdContainer[] = [],
    readonly warnings: string[] = [],
    readonly metadata: EdsMetadata = { fileInfo: {}, deviceInfo: {}, deviceComissioning: {} }
  ) {
    for (const entry of entries) this.entryMap.set(`${entry.index}:${entry.subIndex}`, entry);
    for (const container of containers) this.containerMap.set(container.index, container);
  }

  lookup(index: number, subIndex: number): OdEntry | undefined {
    return this.entryMap.get(`${index}:${subIndex}`);
  }

  object(index: number): OdContainer | undefined {
    return this.containerMap.get(index);
  }

  commissioningNodeId(): number | undefined {
    const nodeId = staticUnsigned(this.metadata.deviceComissioning.nodeid);
    return nodeId !== undefined && nodeId >= 1 && nodeId <= 127 ? nodeId : undefined;
  }

  metadataSummary() {
    const info = this.metadata.deviceInfo;
    const commissioning = this.metadata.deviceComissioning;
    const allowedBaudRatesKbps = [10, 20, 50, 125, 250, 500, 800, 1000]
      .filter(rate => {
        const supported = staticUnsigned(info[`baudrate_${rate}`]);
        return supported !== undefined && supported !== 0;
      });
    const nodeId = this.commissioningNodeId();
    const bitrateKbps = staticUnsigned(commissioning.baudrate);
    return {
      file: {
        ...(this.metadata.fileInfo.filename ? { fileName: this.metadata.fileInfo.filename } : {}),
        ...(this.metadata.fileInfo.fileversion ? { fileVersion: this.metadata.fileInfo.fileversion } : {}),
        ...(this.metadata.fileInfo.filerevision ? { fileRevision: this.metadata.fileInfo.filerevision } : {}),
        ...(this.metadata.fileInfo.edsversion ? { edsVersion: this.metadata.fileInfo.edsversion } : {}),
        ...(this.metadata.fileInfo.description ? { description: this.metadata.fileInfo.description } : {})
      },
      device: {
        ...(info.vendorname ? { vendorName: info.vendorname } : {}),
        ...(staticUnsigned(info.vendornumber) !== undefined ? { vendorNumber: staticUnsigned(info.vendornumber) } : {}),
        ...(info.productname ? { productName: info.productname } : {}),
        ...(staticUnsigned(info.productnumber) !== undefined ? { productNumber: staticUnsigned(info.productnumber) } : {}),
        ...(staticUnsigned(info.revisionnumber) !== undefined ? { revisionNumber: staticUnsigned(info.revisionnumber) } : {}),
        ...(allowedBaudRatesKbps.length ? { allowedBaudRatesKbps } : {}),
        ...(staticUnsigned(info.nrofrxpdo) !== undefined ? { nrOfRxPdo: staticUnsigned(info.nrofrxpdo) } : {}),
        ...(staticUnsigned(info.nroftxpdo) !== undefined ? { nrOfTxPdo: staticUnsigned(info.nroftxpdo) } : {}),
        ...(staticUnsigned(info.lss_supported) !== undefined ? { lssSupported: staticUnsigned(info.lss_supported) !== 0 } : {})
      },
      commissioning: {
        ...(nodeId !== undefined ? { nodeId } : {}),
        ...(bitrateKbps !== undefined ? { bitrateKbps } : {}),
        ...(commissioning.nodename ? { nodeName: commissioning.nodename } : {}),
        ...(staticUnsigned(commissioning.netnumber) !== undefined ? { netNumber: staticUnsigned(commissioning.netnumber) } : {}),
        ...(commissioning.networkname ? { networkName: commissioning.networkname } : {})
      }
    };
  }

  communicationProfile(nodeId?: number) {
    if (nodeId !== undefined && (!Number.isInteger(nodeId) || nodeId < 1 || nodeId > 127)) {
      throw new Error('CANopen nodeId must be between 1 and 127.');
    }
    const commissionedNodeId = this.commissioningNodeId();
    const effectiveNodeId = nodeId ?? commissionedNodeId;

    const resolved = (index: number, subIndex: number) => {
      const entry = this.lookup(index, subIndex);
      const raw = entryRawValue(entry);
      const value = resolveEdsUnsigned(raw, effectiveNodeId);
      return raw === undefined ? undefined : {
        raw,
        ...(value !== undefined ? { value } : {}),
        ...(entry?.parameterName ? { parameterName: entry.parameterName } : {})
      };
    };

    const cob11 = (
      entry: ReturnType<typeof resolved>,
      options: { invalidBit31?: boolean; producerBit30?: boolean; consumerBit31?: boolean; noRtrBit30?: boolean } = {}
    ) => {
      if (!entry) return undefined;
      const value = entry.value;
      const producer = value !== undefined && options.producerBit30 ? (value & 0x40000000) !== 0 : undefined;
      const consumer = value !== undefined && options.consumerBit31 ? (value & 0x80000000) !== 0 : undefined;
      const enabled = value !== undefined && options.invalidBit31 ? (value & 0x80000000) === 0 : undefined;
      const noRtr = value !== undefined && options.noRtrBit30 ? (value & 0x40000000) !== 0 : undefined;
      const allowedControlMask =
        (options.invalidBit31 || options.consumerBit31 ? 0x80000000 : 0) |
        (options.producerBit30 || options.noRtrBit30 ? 0x40000000 : 0) |
        0x000007ff;
      const reservedBits = value === undefined ? undefined : (value & (~allowedControlMask >>> 0)) >>> 0;
      return {
        ...entry,
        canId: value === undefined ? undefined : value & 0x7ff,
        canIdHex: value === undefined ? undefined : `0x${(value & 0x7ff).toString(16).toUpperCase().padStart(3, '0')}`,
        reservedBitsClear: reservedBits === undefined ? undefined : reservedBits === 0,
        enabled,
        producer,
        consumer,
        noRtr
      };
    };

    const pdo = (direction: 'rpdo' | 'tpdo', slot: number) => {
      const commIndex = (direction === 'rpdo' ? 0x1400 : 0x1800) + slot;
      const mapIndex = (direction === 'rpdo' ? 0x1600 : 0x1a00) + slot;
      const cob = resolved(commIndex, 1);
      const transmissionType = resolved(commIndex, 2);
      const mappedObjectCount = resolved(mapIndex, 0);
      if (!cob && !transmissionType && !mappedObjectCount && !this.object(commIndex) && !this.object(mapIndex)) return undefined;
      const cobId = cob11(cob, { invalidBit31: true, noRtrBit30: direction === 'tpdo' });
      return {
        slot: slot + 1,
        communicationIndex: commIndex,
        communicationIndexHex: `0x${commIndex.toString(16).toUpperCase().padStart(4, '0')}`,
        mappingIndex: mapIndex,
        mappingIndexHex: `0x${mapIndex.toString(16).toUpperCase().padStart(4, '0')}`,
        ...(cobId ? { cobId } : {}),
        ...(transmissionType ? { transmissionType } : {}),
        ...(mappedObjectCount ? { mappedObjectCount } : {})
      };
    };

    const syncCobId = cob11(resolved(0x1005, 0), { producerBit30: true });
    const timeCobId = cob11(resolved(0x1012, 0), { producerBit30: true, consumerBit31: true });
    const emcyCobId = cob11(resolved(0x1014, 0), { invalidBit31: true });
    const sdoRx = cob11(resolved(0x1200, 1), { invalidBit31: true });
    const sdoTx = cob11(resolved(0x1200, 2), { invalidBit31: true });
    const heartbeat = resolved(0x1017, 0);
    const syncOverflow = resolved(0x1019, 0);

    return {
      ...(effectiveNodeId !== undefined ? {
        nodeId: effectiveNodeId,
        nodeIdSource: nodeId !== undefined ? 'explicit' : 'dcf'
      } : {}),
      syncCobId,
      timeCobId,
      emcyCobId,
      producerHeartbeat: heartbeat,
      syncCounterOverflow: syncOverflow,
      sdoServer: (sdoRx || sdoTx) ? {
        clientToServerCobId: sdoRx,
        serverToClientCobId: sdoTx
      } : undefined,
      rpdo: Array.from({ length: 4 }, (_, slot) => pdo('rpdo', slot)).filter(Boolean),
      tpdo: Array.from({ length: 4 }, (_, slot) => pdo('tpdo', slot)).filter(Boolean)
    };
  }

  inspect(startIndex = 0, limit = 64, nodeId?: number) {
    if (!Number.isInteger(startIndex) || startIndex < 0 || startIndex > 0xffff ||
        !Number.isInteger(limit) || limit < 1 || limit > 128) {
      throw new Error('Invalid OD inspection bounds.');
    }
    const eligible = this.entries.filter(entry => entry.index >= startIndex);
    const entries = eligible.slice(0, limit);
    return {
      totalEntries: this.entries.length,
      totalObjects: new Set([
        ...this.entries.map(entry => entry.index),
        ...this.containers.map(container => container.index)
      ]).size,
      containerCount: this.containers.length,
      startIndex,
      limit,
      entries,
      metadata: this.metadataSummary(),
      communicationProfile: this.communicationProfile(nodeId),
      hasMore: eligible.length > entries.length,
      warnings: this.warnings.slice(0, MAX_WARNINGS)
    };
  }
}

export function parseEds(text: string): ObjectDictionary {
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('EDS file exceeds byte limit.');
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines.length > MAX_LINES) throw new Error('EDS line limit exceeded.');

  const sections: RawSection[] = [];
  const sectionKeys = new Set<string>();
  const warnings: string[] = [];
  const metadata: EdsMetadata = { fileInfo: {}, deviceInfo: {}, deviceComissioning: {} };
  let metadataFieldCount = 0;
  let sectionCount = 0;
  let current: RawSection | undefined;
  let metadataCurrent: keyof EdsMetadata | undefined;

  for (const raw of lines) {
    if (raw.length > 2048) throw new Error('EDS line length limit exceeded.');
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;

    if (line.startsWith('[')) {
      sectionCount += 1;
      if (sectionCount > MAX_SECTIONS) throw new Error('EDS section limit exceeded.');
      current = undefined;
      metadataCurrent = undefined;

      const header = /^\[([^\]]{1,64})\]$/.exec(line)?.[1]?.trim();
      if (!header) continue;
      const headerKey = header.toLowerCase();
      if (headerKey === 'fileinfo') {
        metadataCurrent = 'fileInfo';
        continue;
      }
      if (headerKey === 'deviceinfo') {
        metadataCurrent = 'deviceInfo';
        continue;
      }
      if (headerKey === 'devicecomissioning' || headerKey === 'devicecommissioning') {
        metadataCurrent = 'deviceComissioning';
        continue;
      }

      const match = /^([0-9a-fA-F]{4})(?:sub([0-9a-fA-F]{1,2}))?$/i.exec(header);
      if (!match) continue;

      const index = Number.parseInt(match[1]!, 16);
      const explicitSubIndex = match[2] === undefined ? undefined : Number.parseInt(match[2], 16);
      const identity = `${index}:${explicitSubIndex === undefined ? 'base' : explicitSubIndex}`;
      if (sectionKeys.has(identity)) throw new Error('Duplicate EDS object section.');
      sectionKeys.add(identity);
      if (sections.length >= MAX_SECTIONS) throw new Error('EDS object section limit exceeded.');

      current = {
        index,
        indexHex: `0x${match[1]!.toUpperCase()}`,
        ...(explicitSubIndex !== undefined ? { explicitSubIndex } : {}),
        name: match[2] === undefined ? match[1]!.toUpperCase() : `${match[1]!.toUpperCase()}sub${match[2]!.toUpperCase()}`,
        values: {}
      };
      sections.push(current);
      continue;
    }

    const equals = line.indexOf('=');
    if (equals < 1) continue;
    const rawKey = line.slice(0, equals).trim();

    if (!current) {
      if (!metadataCurrent) continue;
      if (metadataFieldCount >= MAX_METADATA_FIELDS) throw new Error('EDS metadata field limit exceeded.');
      const key = rawKey.toLowerCase();
      if (!/^[a-z0-9_]{1,64}$/.test(key)) {
        if (warnings.length < MAX_WARNINGS) warnings.push(`Ignored invalid metadata key ${rawKey.slice(0, 64)}.`);
        continue;
      }
      metadata[metadataCurrent][key] = boundedValue(line.slice(equals + 1));
      metadataFieldCount += 1;
      continue;
    }

    const property = FIELD_MAP.get(rawKey.toLowerCase());
    if (!property) {
      if (warnings.length < MAX_WARNINGS) warnings.push(`Ignored unsupported field ${rawKey.slice(0, 64)} in [${current.name}].`);
      continue;
    }
    const value = boundedValue(line.slice(equals + 1));
    if (current.values[property] !== undefined && warnings.length < MAX_WARNINGS) {
      warnings.push(`Duplicate field ${rawKey.slice(0, 64)} in [${current.name}]; last value used.`);
    }
    current.values[property] = value;
  }

  const grouped = new Map<number, { base?: RawSection; subs: RawSection[] }>();
  for (const section of sections) {
    const group = grouped.get(section.index) ?? { subs: [] };
    if (section.explicitSubIndex === undefined) group.base = section;
    else group.subs.push(section);
    grouped.set(section.index, group);
  }

  const entries: OdEntry[] = [];
  const containers: OdContainer[] = [];
  for (const index of [...grouped.keys()].sort((a, b) => a - b)) {
    const group = grouped.get(index)!;
    const base = group.base;
    const objectType = staticUnsigned(base?.values.objectType);
    const isContainer = Boolean(base && (group.subs.length > 0 || base.values.subNumber !== undefined || objectType === 0x08 || objectType === 0x09));
    const parent = base && isContainer ? containerFrom(base, warnings) : undefined;
    if (parent) containers.push(parent);

    if (base && !isContainer) {
      if (entries.length >= MAX_ENTRIES) throw new Error('EDS entry limit exceeded.');
      entries.push(entryFrom(base, 0));
    }

    for (const sub of group.subs.sort((a, b) => a.explicitSubIndex! - b.explicitSubIndex!)) {
      if (entries.length >= MAX_ENTRIES) throw new Error('EDS entry limit exceeded.');
      entries.push(entryFrom(sub, sub.explicitSubIndex!, parent));
    }

    if (base && isContainer && group.subs.length === 0 && warnings.length < MAX_WARNINGS) {
      warnings.push(`Object ${base.indexHex} is declared as a container but has no explicit sub-object sections.`);
    }
  }

  return new ObjectDictionary(
    entries.sort((a, b) => a.index - b.index || a.subIndex - b.subIndex),
    containers.sort((a, b) => a.index - b.index),
    warnings,
    metadata
  );
}

export class CanopenEds {
  constructor(private readonly paths: PathGuard) {}

  async load(workspace: string, projectPath: string, edsPath: string): Promise<ObjectDictionary> {
    if (!edsPath || edsPath.length > 1024 || path.isAbsolute(edsPath) || edsPath.includes('\0') || !/\.(eds|dcf)$/i.test(edsPath)) {
      throw new Error('EDS/DCF path must be a project-relative .eds or .dcf file.');
    }
    const absolute = await resolveExistingProjectPath(this.paths, workspace, projectPath, edsPath, 'EDS/DCF path');
    const stat = await fs.stat(absolute);
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('EDS/DCF file size limit exceeded.');
    const data = await fs.readFile(absolute);
    if (data.length > MAX_BYTES) throw new Error('EDS/DCF file size limit exceeded.');
    return parseEds(data.toString('utf8'));
  }
}

function bigintLe(bytes: Buffer, signed: boolean): bigint {
  let value = 0n;
  for (let i = bytes.length - 1; i >= 0; i -= 1) value = (value << 8n) | BigInt(bytes[i]!);
  if (signed && bytes.length > 0) {
    const bits = BigInt(bytes.length * 8);
    const signBit = 1n << (bits - 1n);
    if ((value & signBit) !== 0n) value -= 1n << bits;
  }
  return value;
}

function safeNumeric(big: bigint): number | string {
  return big >= BigInt(Number.MIN_SAFE_INTEGER) && big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : big.toString();
}

function decodeValue(raw: string, dataType: string | undefined): unknown {
  const type = staticUnsigned(dataType);
  if (raw.length % 2 || !/^[0-9a-f]*$/i.test(raw)) return undefined;
  const bytes = Buffer.from(raw, 'hex');
  if (type === 0x0001 && bytes.length === 1) return bytes[0] !== 0;

  const signedWidths = new Map<number, number>([
    [0x0002, 1], [0x0003, 2], [0x0004, 4], [0x0010, 3],
    [0x0012, 5], [0x0013, 6], [0x0014, 7], [0x0015, 8]
  ]);
  const unsignedWidths = new Map<number, number>([
    [0x0005, 1], [0x0006, 2], [0x0007, 4], [0x0016, 3],
    [0x0018, 5], [0x0019, 6], [0x001a, 7], [0x001b, 8]
  ]);
  const signedWidth = signedWidths.get(type ?? -1);
  if (signedWidth === bytes.length) return safeNumeric(bigintLe(bytes, true));
  const unsignedWidth = unsignedWidths.get(type ?? -1);
  if (unsignedWidth === bytes.length) return safeNumeric(bigintLe(bytes, false));

  if (type === 0x0008 && bytes.length === 4) return bytes.readFloatLE(0);
  if (type === 0x0011 && bytes.length === 8) return bytes.readDoubleLE(0);
  if (type === 0x0009 && bytes.every(byte => (byte >= 0x20 && byte <= 0x7e) || byte === 0)) {
    return bytes.toString('ascii').replace(/\0+$/, '');
  }
  if (type === 0x000a) return `0x${raw.toUpperCase()}`;
  if (type === 0x000b && bytes.length % 2 === 0) {
    try {
      return new TextDecoder('utf-16le', { fatal: true }).decode(bytes).replace(/\0+$/, '');
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export type SemanticEvidence = {
  rawHex: string;
  object?: OdEntry;
  value?: unknown;
  mapped?: Array<{
    object?: OdEntry;
    index: number;
    subIndex: number;
    bitLength: number;
    rawHex: string;
    value?: unknown;
  }>;
};

function expeditedPayloadSize(kind: string, command: number | undefined): number {
  if (command === undefined) return 0;
  const expected = kind === 'sdo-request' ? 0x23 : kind === 'sdo-response' ? 0x43 : -1;
  if ((command & 0xe3) !== expected) return 0;
  return 4 - ((command >> 2) & 0x03);
}

export function enrichSemanticFrame<T extends DecodedCanopenFrame>(
  frame: RawCanopenFrame,
  decoded: T,
  dictionary: ObjectDictionary
): T & { semantic?: SemanticEvidence } {
  const bytes = frame.data;

  if ((decoded.kind === 'sdo-request' || decoded.kind === 'sdo-response') && decoded.object) {
    const object = dictionary.lookup(decoded.object.index, decoded.object.subIndex);
    const size = expeditedPayloadSize(decoded.kind, decoded.commandSpecifier);
    const payloadHex = size > 0 ? bytes.slice(4, 4 + size).join('').toUpperCase() : bytes.slice(4, 8).join('').toUpperCase();
    const value = object && size > 0 ? decodeValue(payloadHex, object.dataType) : undefined;
    return {
      ...decoded,
      semantic: {
        ...(object ? { object } : {}),
        rawHex: payloadHex,
        ...(value !== undefined ? { value } : {})
      }
    };
  }

  if (/^[tr]pdo[1-4]$/.test(decoded.kind)) {
    const slot = Number(decoded.kind.at(-1)) - 1;
    const mappingIndex = (decoded.kind.startsWith('tpdo') ? 0x1a00 : 0x1600) + slot;
    const countEntry = dictionary.lookup(mappingIndex, 0);
    const count = staticUnsigned(countEntry?.parameterValue ?? countEntry?.defaultValue);
    const rawHex = frame.dataHex.slice(0, 16).toUpperCase();
    if (count === undefined || count < 1 || count > 8) return { ...decoded, semantic: { rawHex } };

    const mapped: NonNullable<SemanticEvidence['mapped']> = [];
    let bitOffset = 0;
    for (let sub = 1; sub <= count; sub += 1) {
      const record = dictionary.lookup(mappingIndex, sub);
      const mapping = staticUnsigned(record?.parameterValue ?? record?.defaultValue);
      if (mapping === undefined || mapping > 0xffffffff) return { ...decoded, semantic: { rawHex } };

      const index = mapping >>> 16;
      const subIndex = (mapping >>> 8) & 0xff;
      const bitLength = mapping & 0xff;
      if (!bitLength || bitLength % 8 !== 0 || bitOffset % 8 !== 0 ||
          bitOffset + bitLength > frame.dlc * 8 ||
          bitOffset + bitLength > bytes.length * 8 ||
          bitOffset + bitLength > 64) {
        return { ...decoded, semantic: { rawHex } };
      }

      const fieldHex = bytes.slice(bitOffset / 8, (bitOffset + bitLength) / 8).join('').toUpperCase();
      const object = dictionary.lookup(index, subIndex);
      const value = object ? decodeValue(fieldHex, object.dataType) : undefined;
      mapped.push({
        ...(object ? { object } : {}),
        index,
        subIndex,
        bitLength,
        rawHex: fieldHex,
        ...(value !== undefined ? { value } : {})
      });
      bitOffset += bitLength;
    }
    return { ...decoded, semantic: { rawHex, mapped } };
  }

  return decoded;
}
