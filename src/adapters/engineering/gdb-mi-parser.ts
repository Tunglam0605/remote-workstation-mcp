export type MiValue = string | MiTuple | MiList;
export interface MiTuple { [key: string]: MiValue; }
export type MiList = Array<MiValue | { key: string; value: MiValue }>;

class Cursor {
  constructor(readonly text: string, public index = 0) {}
  peek(): string { return this.text[this.index] ?? ''; }
  take(): string { return this.text[this.index++] ?? ''; }
  eof(): boolean { return this.index >= this.text.length; }
}

function parseCString(cursor: Cursor): string {
  if (cursor.take() !== '"') throw new Error('MI string must start with quote.');
  let out = '';
  while (!cursor.eof()) {
    const ch = cursor.take();
    if (ch === '"') return out;
    if (ch !== '\\') { out += ch; continue; }
    if (cursor.eof()) throw new Error('MI string ends with incomplete escape.');
    const esc = cursor.take();
    if (esc === 'n') out += '\n';
    else if (esc === 't') out += '\t';
    else if (esc === 'r') out += '\r';
    else if (esc === '"') out += '"';
    else if (esc === '\\') out += '\\';
    else if (/[0-7]/.test(esc)) {
      let octal = esc;
      for (let i = 0; i < 2 && /[0-7]/.test(cursor.peek()); i += 1) octal += cursor.take();
      out += String.fromCharCode(Number.parseInt(octal, 8));
    } else out += esc;
  }
  throw new Error('Unterminated MI string.');
}

function parseBare(cursor: Cursor): string {
  const start = cursor.index;
  while (!cursor.eof() && !/[\],}]/.test(cursor.peek())) cursor.index += 1;
  return cursor.text.slice(start, cursor.index);
}

function parseName(cursor: Cursor): string {
  const start = cursor.index;
  while (!cursor.eof() && /[A-Za-z0-9_.-]/.test(cursor.peek())) cursor.index += 1;
  if (cursor.index === start) throw new Error('Expected MI field name.');
  return cursor.text.slice(start, cursor.index);
}

function parseValue(cursor: Cursor, depth: number): MiValue {
  if (depth > 16) throw new Error('MI nesting exceeds maximum depth.');
  if (cursor.peek() === '"') return parseCString(cursor);
  if (cursor.peek() === '{') return parseTuple(cursor, depth + 1);
  if (cursor.peek() === '[') return parseList(cursor, depth + 1);
  return parseBare(cursor);
}

function parseResult(cursor: Cursor, depth: number): { key: string; value: MiValue } {
  const key = parseName(cursor);
  if (cursor.take() !== '=') throw new Error(`Expected '=' after MI field '${key}'.`);
  return { key, value: parseValue(cursor, depth) };
}

function parseTuple(cursor: Cursor, depth: number): MiTuple {
  if (cursor.take() !== '{') throw new Error('Expected MI tuple.');
  const out: MiTuple = {};
  if (cursor.peek() === '}') { cursor.take(); return out; }
  while (!cursor.eof()) {
    const { key, value } = parseResult(cursor, depth);
    out[key] = value;
    const next = cursor.take();
    if (next === '}') return out;
    if (next !== ',') throw new Error('Malformed MI tuple separator.');
  }
  throw new Error('Unterminated MI tuple.');
}

function parseList(cursor: Cursor, depth: number): MiList {
  if (cursor.take() !== '[') throw new Error('Expected MI list.');
  const out: MiList = [];
  if (cursor.peek() === ']') { cursor.take(); return out; }
  while (!cursor.eof()) {
    const checkpoint = cursor.index;
    let item: MiValue | { key: string; value: MiValue };
    try {
      const key = parseName(cursor);
      if (cursor.peek() === '=') {
        cursor.take();
        item = { key, value: parseValue(cursor, depth) };
      } else {
        cursor.index = checkpoint;
        item = parseValue(cursor, depth);
      }
    } catch {
      cursor.index = checkpoint;
      item = parseValue(cursor, depth);
    }
    out.push(item);
    const next = cursor.take();
    if (next === ']') return out;
    if (next !== ',') throw new Error('Malformed MI list separator.');
  }
  throw new Error('Unterminated MI list.');
}

export function parseMiResults(payload: string): MiTuple {
  if (Buffer.byteLength(payload, 'utf8') > 1024 * 1024) throw new Error('MI payload exceeds 1 MiB limit.');
  const cursor = new Cursor(payload);
  const out: MiTuple = {};
  if (!payload) return out;
  while (!cursor.eof()) {
    const { key, value } = parseResult(cursor, 0);
    out[key] = value;
    if (cursor.eof()) break;
    if (cursor.take() !== ',') throw new Error('Malformed MI result separator.');
  }
  return out;
}

export function miString(value: MiValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function miTuple(value: MiValue | undefined): MiTuple | undefined {
  return value && !Array.isArray(value) && typeof value === 'object' ? value as MiTuple : undefined;
}

export function miList(value: MiValue | undefined): MiList | undefined {
  return Array.isArray(value) ? value : undefined;
}

export function miResultField(payload: string, name: string): string | undefined {
  return miString(parseMiResults(payload)[name]);
}
