function decodeMi(value: string): string {
  return value.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

function field(record: string, name: string): string | undefined {
  const match = record.match(new RegExp(`(?:^|,)${name}="((?:\\\\.|[^"\\\\])*)"`));
  return match ? decodeMi(match[1]!) : undefined;
}

export interface DebugLocalVariable {
  name: string;
  value?: string;
  type?: string;
  argument?: boolean;
}

export interface DebugInstruction {
  address: number;
  addressHex: string;
  function?: string;
  offset?: number;
  instruction: string;
}

export function parseDebugLocals(payload: string, limit = 64): DebugLocalVariable[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > 128) throw new Error('local variable limit must be in range 1..128.');
  const values: DebugLocalVariable[] = [];
  for (const match of payload.matchAll(/\{([^{}]*)\}/g)) {
    const record = match[1]!;
    const name = field(record, 'name');
    if (!name) continue;
    const value = field(record, 'value');
    const type = field(record, 'type');
    const arg = field(record, 'arg');
    values.push({
      name: name.slice(0, 256),
      ...(value !== undefined ? { value: value.slice(0, 1024) } : {}),
      ...(type !== undefined ? { type: type.slice(0, 256) } : {}),
      ...(arg !== undefined ? { argument: arg === '1' } : {})
    });
    if (values.length >= limit) break;
  }
  return values;
}

export function parseDebugDisassembly(payload: string, limit = 128): DebugInstruction[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > 256) throw new Error('instruction limit must be in range 1..256.');
  const values: DebugInstruction[] = [];
  for (const match of payload.matchAll(/\{([^{}]*)\}/g)) {
    const record = match[1]!;
    const rawAddress = field(record, 'address');
    const instruction = field(record, 'inst');
    if (!rawAddress || !instruction || !/^0x[0-9a-f]+$/i.test(rawAddress)) continue;
    const resolvedAddress = Number.parseInt(rawAddress.slice(2), 16);
    if (!Number.isSafeInteger(resolvedAddress)) continue;
    const functionName = field(record, 'func-name');
    const rawOffset = field(record, 'offset');
    const offset = rawOffset && /^\d+$/.test(rawOffset) ? Number(rawOffset) : undefined;
    values.push({
      address: resolvedAddress,
      addressHex: `0x${resolvedAddress.toString(16).padStart(8, '0')}`,
      ...(functionName ? { function: functionName.slice(0, 256) } : {}),
      ...(offset !== undefined ? { offset } : {}),
      instruction: instruction.slice(0, 512)
    });
    if (values.length >= limit) break;
  }
  return values;
}

export function parseDebugBreakpointNumber(payload: string): number {
  const match = /(?:^|[,{])number="([0-9]+)"/.exec(payload);
  const number = match?.[1] ? Number(match[1]) : NaN;
  if (!Number.isInteger(number) || number < 1 || number > 9999) throw new Error('GDB did not return a valid breakpoint/watchpoint number.');
  return number;
}
