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

export interface DebugThreadInfo {
  id: string;
  targetId: string;
  name?: string;
  details?: string;
  state?: 'stopped' | 'running';
  core?: number;
  current: boolean;
  frame?: {
    address?: string;
    function?: string;
    file?: string;
    fullname?: string;
    line?: number;
  };
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

export function parseDebugThreads(payload: string, limit = 128): { currentThreadId?: string; threads: DebugThreadInfo[] } {
  if (!Number.isInteger(limit) || limit < 1 || limit > 256) throw new Error('thread limit must be in range 1..256.');
  const root = parseMiResults(payload);
  const currentThreadId = miString(root['current-thread-id']);
  const records = tuplesFromList(root.threads);
  const threads = records.slice(0, limit).flatMap(record => {
    const id = miString(record.id);
    const targetId = miString(record['target-id']);
    if (!id || !targetId) return [];
    const name = miString(record.name);
    const details = miString(record.details);
    const stateRaw = miString(record.state);
    const state: DebugThreadInfo['state'] = stateRaw === 'stopped' || stateRaw === 'running' ? stateRaw : undefined;
    const coreRaw = miString(record.core);
    const frameTuple = miTuple(record.frame);
    const lineRaw = frameTuple ? miString(frameTuple.line) : undefined;
    const core = coreRaw && /^\d+$/.test(coreRaw) ? Number(coreRaw) : undefined;
    const frame = frameTuple ? {
      ...(miString(frameTuple.addr) ? { address: miString(frameTuple.addr) } : {}),
      ...(miString(frameTuple.func) ? { function: miString(frameTuple.func)?.slice(0, 256) } : {}),
      ...(miString(frameTuple.file) ? { file: miString(frameTuple.file)?.slice(0, 512) } : {}),
      ...(miString(frameTuple.fullname) ? { fullname: miString(frameTuple.fullname)?.slice(0, 1024) } : {}),
      ...(lineRaw && /^\d+$/.test(lineRaw) ? { line: Number(lineRaw) } : {})
    } : undefined;
    return [{
      id: id.slice(0, 64),
      targetId: targetId.slice(0, 512),
      ...(name ? { name: name.slice(0, 256) } : {}),
      ...(details ? { details: details.slice(0, 1024) } : {}),
      ...(state ? { state } : {}),
      ...(core !== undefined ? { core } : {}),
      current: id === currentThreadId,
      ...(frame && Object.keys(frame).length > 0 ? { frame } : {})
    }];
  });
  return { ...(currentThreadId ? { currentThreadId } : {}), threads };
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
