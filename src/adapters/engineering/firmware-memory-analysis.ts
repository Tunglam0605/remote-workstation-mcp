export interface FirmwareMemorySummary {
  textBytes: number;
  dataBytes: number;
  bssBytes: number;
  flashBytes: number;
  ramBytes: number;
  totalImageBytes: number;
}

export interface FirmwareMemorySection {
  name: string;
  sizeBytes: number;
  address?: number;
}

export interface FirmwareMemorySymbol {
  name: string;
  sizeBytes: number;
  address?: number;
  type?: string;
}

function decimal(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function address(value: string): number | undefined {
  if (/^0x[0-9a-f]+$/i.test(value)) {
    const parsed = Number.parseInt(value.slice(2), 16);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }
  if (/^[0-9a-f]+$/i.test(value) && /[a-f]/i.test(value)) {
    const parsed = Number.parseInt(value, 16);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }
  return decimal(value);
}

export function parseFirmwareBerkeleySize(text: string): FirmwareMemorySummary {
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+[0-9a-fA-F]+(?:\s+.+)?\s*$/.exec(line);
    if (!match) continue;
    const textBytes = Number(match[1]);
    const dataBytes = Number(match[2]);
    const bssBytes = Number(match[3]);
    const totalImageBytes = Number(match[4]);
    if (![textBytes, dataBytes, bssBytes, totalImageBytes].every(Number.isSafeInteger)) continue;
    return {
      textBytes,
      dataBytes,
      bssBytes,
      flashBytes: textBytes + dataBytes,
      ramBytes: dataBytes + bssBytes,
      totalImageBytes
    };
  }
  throw new Error('Unable to parse Berkeley size output for firmware artifact.');
}

export function parseFirmwareSections(text: string, limit = 256): FirmwareMemorySection[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1024) throw new Error('section limit must be in range 1..1024.');
  const sections: FirmwareMemorySection[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(\.[A-Za-z0-9_.$+-]+|[A-Za-z][A-Za-z0-9_.$+-]*)\s+(\d+)\s+([0-9A-Fa-fx]+)\s*$/.exec(line);
    if (!match) continue;
    const sizeBytes = decimal(match[2]!);
    if (sizeBytes === undefined) continue;
    const resolvedAddress = address(match[3]!);
    sections.push({ name: match[1]!, sizeBytes, ...(resolvedAddress !== undefined ? { address: resolvedAddress } : {}) });
    if (sections.length >= limit) break;
  }
  return sections;
}

export function parseFirmwareSymbols(text: string, limit = 25): FirmwareMemorySymbol[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('symbol limit must be in range 1..100.');
  const symbols: FirmwareMemorySymbol[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+([A-Za-z?])\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const resolvedAddress = decimal(match[1]!);
    const sizeBytes = decimal(match[2]!);
    if (sizeBytes === undefined || sizeBytes === 0) continue;
    const name = match[4]!.trim().slice(0, 512);
    if (!name) continue;
    symbols.push({ name, sizeBytes, ...(resolvedAddress !== undefined ? { address: resolvedAddress } : {}), type: match[3] });
  }
  return symbols.sort((a, b) => b.sizeBytes - a.sizeBytes || a.name.localeCompare(b.name)).slice(0, limit);
}
