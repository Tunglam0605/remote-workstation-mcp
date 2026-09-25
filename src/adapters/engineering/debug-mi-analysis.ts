import { miList, miString, miTuple, parseMiResults, type MiTuple, type MiValue } from './gdb-mi-parser.js';

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

function tuplesFromList(value: MiValue | undefined): MiTuple[] {
  return (miList(value) ?? []).flatMap(item => {
    if (item && typeof item === 'object' && !Array.isArray(item) && 'key' in item && 'value' in item) {
      const tuple = miTuple(item.value);
      return tuple ? [tuple] : [];
    }
    const tuple = miTuple(item as MiValue);
    return tuple ? [tuple] : [];
  });
}

export function parseDebugLocals(payload: string, limit = 64): DebugLocalVariable[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > 128) throw new Error('local variable limit must be in range 1..128.');
  const root = parseMiResults(payload);
  const variables = tuplesFromList(root.variables);
  return variables.slice(0, limit).flatMap(record => {
    const name = miString(record.name);
    if (!name) return [];
    const value = miString(record.value);
    const type = miString(record.type);
    const arg = miString(record.arg);
    return [{
      name: name.slice(0, 256),
      ...(value !== undefined ? { value: value.slice(0, 1024) } : {}),
      ...(type !== undefined ? { type: type.slice(0, 256) } : {}),
      ...(arg !== undefined ? { argument: arg === '1' } : {})
    }];
  });
}

export function parseDebugDisassembly(payload: string, limit = 128): DebugInstruction[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > 256) throw new Error('instruction limit must be in range 1..256.');
  const root = parseMiResults(payload);
  const records = tuplesFromList(root.asm_insns);
  const values: DebugInstruction[] = [];
  for (const record of records) {
    const rawAddress = miString(record.address);
    const instruction = miString(record.inst);
    if (!rawAddress || !instruction || !/^0x[0-9a-f]+$/i.test(rawAddress)) continue;
    const resolvedAddress = Number.parseInt(rawAddress.slice(2), 16);
    if (!Number.isSafeInteger(resolvedAddress)) continue;
    const functionName = miString(record['func-name']);
    const rawOffset = miString(record.offset);
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
  const root = parseMiResults(payload);
  const candidates = [root.wpt, root.bkpt, root.hw_awpt, root.hw_rwpt, root];
  let raw: string | undefined;
  for (const candidate of candidates) {
    const tuple = miTuple(candidate as MiValue) ?? (candidate === root ? root : undefined);
    raw = tuple ? miString(tuple.number) : undefined;
    if (raw !== undefined) break;
  }
  const number = raw && /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(number) || number < 1 || number > 9999) throw new Error('GDB did not return a valid breakpoint/watchpoint number.');
  return number;
}
