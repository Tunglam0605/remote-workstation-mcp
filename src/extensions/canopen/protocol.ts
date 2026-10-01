export type CanopenMessageKind =
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

const SDO_ABORT_NAMES = new Map<number, string>([
  [0x05030000, 'toggle-bit-not-altered'],
  [0x05040000, 'protocol-timeout'],
  [0x05040001, 'invalid-command-specifier'],
  [0x05040002, 'invalid-block-size'],
  [0x05040003, 'invalid-sequence-number'],
  [0x05040004, 'block-crc-error'],
  [0x05040005, 'out-of-memory'],
  [0x06010000, 'unsupported-object-access'],
  [0x06010001, 'attempt-read-write-only'],
  [0x06010002, 'attempt-write-read-only'],
  [0x06020000, 'object-not-present'],
  [0x06040041, 'object-cannot-map-to-pdo'],
  [0x06040042, 'pdo-mapping-length-exceeded'],
  [0x06040043, 'parameter-incompatibility'],
  [0x06040047, 'device-incompatibility'],
  [0x06060000, 'hardware-access-failure'],
  [0x06070010, 'data-type-or-length-mismatch'],
  [0x06070012, 'service-parameter-too-long'],
  [0x06070013, 'service-parameter-too-short'],
  [0x06090011, 'sub-index-not-present'],
  [0x06090030, 'invalid-parameter-value'],
  [0x06090031, 'parameter-value-too-high'],
  [0x06090032, 'parameter-value-too-low'],
  [0x06090036, 'maximum-less-than-minimum'],
  [0x060a0023, 'sdo-connection-resource-unavailable'],
  [0x08000000, 'general-error'],
  [0x08000020, 'data-transfer-or-storage-failed'],
  [0x08000021, 'data-transfer-blocked-by-local-control'],
  [0x08000022, 'data-transfer-blocked-by-device-state'],
  [0x08000023, 'object-dictionary-unavailable'],
  [0x08000024, 'no-data-available']
]);

const EMCY_EXACT = new Map<number, string>([
  [0x0000, 'reset-or-no-error'],
  [0x8110, 'can-overrun'],
  [0x8120, 'can-error-passive'],
  [0x8130, 'heartbeat-or-life-guard-error'],
  [0x8140, 'bus-off-recovered'],
  [0x8150, 'can-id-collision'],
  [0x8210, 'pdo-length-error'],
  [0x8220, 'pdo-length-exceeded'],
  [0x8230, 'dam-mpdo-destination-unavailable'],
  [0x8240, 'unexpected-sync-data-length'],
  [0x8250, 'rpdo-timeout']
]);

const ERROR_REGISTER_BITS: Array<[number, string]> = [
  [0x01, 'generic'],
  [0x02, 'current'],
  [0x04, 'voltage'],
  [0x08, 'temperature'],
  [0x10, 'communication'],
  [0x20, 'device-profile-specific'],
  [0x40, 'reserved'],
  [0x80, 'manufacturer-specific']
];

export function describeSdoAbort(code: number | undefined) {
  if (code === undefined) return undefined;
  return {
    code,
    codeHex: `0x${code.toString(16).toUpperCase().padStart(8, '0')}`,
    name: SDO_ABORT_NAMES.get(code) ?? 'reserved-or-vendor-specific'
  };
}

export function describeEmergency(errorCode: number | undefined, errorRegister: number | undefined) {
  const registerFlags = errorRegister === undefined
    ? []
    : ERROR_REGISTER_BITS.filter(([mask]) => (errorRegister & mask) !== 0).map(([, name]) => name);

  let codeClass = 'unknown';
  if (errorCode !== undefined) {
    if (errorCode === 0x0000) codeClass = 'reset';
    else {
      switch (errorCode & 0xf000) {
        case 0x1000: codeClass = 'generic'; break;
        case 0x2000: codeClass = 'current'; break;
        case 0x3000: codeClass = 'voltage'; break;
        case 0x4000: codeClass = 'temperature'; break;
        case 0x5000: codeClass = 'hardware'; break;
        case 0x6000: codeClass = 'software'; break;
        case 0x7000: codeClass = 'additional-module'; break;
        case 0x8000: codeClass = (errorCode & 0xff00) === 0x8100 ? 'communication' : 'monitoring-or-protocol'; break;
        case 0x9000: codeClass = 'external'; break;
        case 0xf000: codeClass = 'additional-function-or-device-specific'; break;
      }
    }
  }

  return {
    ...(errorCode !== undefined ? {
      codeClass,
      codeName: EMCY_EXACT.get(errorCode) ?? codeClass
    } : {}),
    ...(errorRegister !== undefined ? {
      errorRegisterFlags: registerFlags
    } : {})
  };
}

export function describeSdoCommand(
  kind: 'sdo-request' | 'sdo-response',
  command: number | undefined
): Record<string, unknown> | undefined {
  if (command === undefined) return undefined;
  if (command === 0x80) return { commandName: 'abort', transfer: 'abort', phase: 'abort' };

  if (kind === 'sdo-request') {
    if (command === 0x40) return { commandName: 'upload-initiate-request', transfer: 'upload', phase: 'initiate' };
    if ((command & 0xe0) === 0x20) {
      const expedited = (command & 0x02) !== 0;
      const sizeIndicated = (command & 0x01) !== 0;
      return {
        commandName: 'download-initiate-request',
        transfer: 'download',
        phase: 'initiate',
        expedited,
        sizeIndicated,
        ...(expedited && sizeIndicated ? { expeditedPayloadBytes: 4 - ((command >> 2) & 0x03) } : {})
      };
    }
    if ((command & 0xe0) === 0x00) {
      return {
        commandName: 'download-segment-request',
        transfer: 'download',
        phase: 'segment',
        toggle: (command >> 4) & 0x01,
        lastSegment: (command & 0x01) !== 0,
        payloadBytes: 7 - ((command >> 1) & 0x07)
      };
    }
    if ((command & 0xef) === 0x60) {
      return {
        commandName: 'upload-segment-request',
        transfer: 'upload',
        phase: 'segment',
        toggle: (command >> 4) & 0x01
      };
    }
    if ((command & 0xe0) === 0xc0) return { commandName: 'block-download-request', transfer: 'download', phase: 'block' };
    if ((command & 0xe0) === 0xa0) return { commandName: 'block-upload-request', transfer: 'upload', phase: 'block' };
  } else {
    if (command === 0x60) return { commandName: 'download-initiate-response', transfer: 'download', phase: 'initiate' };
    if ((command & 0xef) === 0x20) {
      return {
        commandName: 'download-segment-response',
        transfer: 'download',
        phase: 'segment',
        toggle: (command >> 4) & 0x01
      };
    }
    if ((command & 0xe0) === 0x40) {
      const expedited = (command & 0x02) !== 0;
      const sizeIndicated = (command & 0x01) !== 0;
      return {
        commandName: 'upload-initiate-response',
        transfer: 'upload',
        phase: 'initiate',
        expedited,
        sizeIndicated,
        ...(expedited && sizeIndicated ? { expeditedPayloadBytes: 4 - ((command >> 2) & 0x03) } : {})
      };
    }
    if ((command & 0xe0) === 0x00) {
      return {
        commandName: 'upload-segment-response',
        transfer: 'upload',
        phase: 'segment',
        toggle: (command >> 4) & 0x01,
        lastSegment: (command & 0x01) !== 0,
        payloadBytes: 7 - ((command >> 1) & 0x07)
      };
    }
    if ((command & 0xe0) === 0xa0) return { commandName: 'block-download-response', transfer: 'download', phase: 'block' };
    if ((command & 0xe0) === 0xc0) return { commandName: 'block-upload-response', transfer: 'upload', phase: 'block' };
  }

  return { commandName: 'unknown-or-reserved', transfer: 'unknown', phase: 'unknown' };
}

export function protocolIssues(kind: CanopenMessageKind, dlc: number, data: string[]): string[] {
  const issues: string[] = [];
  const exact = (expected: number) => {
    if (dlc !== expected || data.length !== expected) issues.push(`Expected DLC ${expected}, observed DLC ${dlc} with ${data.length} parsed byte(s).`);
  };

  switch (kind) {
    case 'nmt': exact(2); break;
    case 'emcy': exact(8); break;
    case 'time': exact(6); break;
    case 'heartbeat': exact(1); break;
    case 'sdo-request':
    case 'sdo-response': exact(8); break;
    case 'sync':
      if (!((dlc === 0 && data.length === 0) || (dlc === 1 && data.length === 1))) {
        issues.push(`SYNC expects DLC 0 or 1, observed DLC ${dlc} with ${data.length} parsed byte(s).`);
      }
      if (data.length === 1) {
        const counter = Number.parseInt(data[0] ?? '', 16);
        if (!Number.isInteger(counter) || counter < 1 || counter > 240) {
          issues.push('SYNC counter byte should be in the CiA 301 range 1..240 when present.');
        }
      }
      break;
    default:
      if (dlc < 0 || dlc > 8 || data.length > 8) issues.push('Classic CAN PDO payload exceeds 8 bytes.');
  }
  return issues;
}

export function decodeSyncPayload(data: string[]) {
  if (data.length !== 1) return {};
  const counter = Number.parseInt(data[0]!, 16);
  return Number.isInteger(counter) ? { counter } : {};
}

export function decodeTimePayload(data: string[]) {
  if (data.length !== 6) return {};
  const bytes = data.map(value => Number.parseInt(value, 16));
  if (bytes.some(value => !Number.isInteger(value) || value < 0 || value > 0xff)) return {};
  const millisecondsAfterMidnight = ((bytes[0]! | (bytes[1]! << 8) | (bytes[2]! << 16) | (bytes[3]! << 24)) >>> 0);
  const daysSince1984 = bytes[4]! | (bytes[5]! << 8);
  const validMilliseconds = millisecondsAfterMidnight < 86_400_000;
  const timestampMs = Date.UTC(1984, 0, 1) + daysSince1984 * 86_400_000 + millisecondsAfterMidnight;
  return {
    millisecondsAfterMidnight,
    daysSince1984,
    ...(validMilliseconds ? { utcIso: new Date(timestampMs).toISOString() } : {})
  };
}
