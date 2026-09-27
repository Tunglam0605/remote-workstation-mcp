import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export type KicadEditOperation =
  | { kind: 'schematic_symbol_property'; uuid?: string; reference?: string; property: 'Value' | 'Footprint'; value: string }
  | { kind: 'pcb_footprint_property'; uuid?: string; reference?: string; property: 'Value' | 'Reference'; value: string }
  | { kind: 'pcb_footprint_move'; uuid?: string; reference?: string; x: number; y: number; rotation?: number };

export interface KicadEditPatchResult {
  operation: KicadEditOperation;
  matched: number;
  before?: string;
  after?: string;
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
}

function quote(value: string): string {
  if (value.length > 512) throw new Error('KiCad property value exceeds 512 characters.');
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error('KiCad property value contains control characters.');
  return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function unquote(value: string): string {
  if (!(value.startsWith('"') && value.endsWith('"'))) return value;
  return value.slice(1, -1).replace(/\\(["\\])/g, '$1');
}

function blockEnd(text: string, start: number): number {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i + 1;
      if (depth < 0) break;
    }
  }
  throw new Error('Malformed KiCad S-expression: unbalanced parentheses.');
}

function candidateBlocks(text: string, token: 'symbol' | 'footprint'): Array<{ start: number; end: number; text: string }> {
  const result: Array<{ start: number; end: number; text: string }> = [];
  const marker = '(' + token;
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf(marker, cursor);
    if (start < 0) break;
    const next = text[start + marker.length] ?? '';
    if (next && !/\s|"/.test(next)) { cursor = start + marker.length; continue; }
    const end = blockEnd(text, start);
    result.push({ start, end, text: text.slice(start, end) });
    cursor = end;
  }
  return result;
}

function identifierMatches(block: string, uuid?: string, reference?: string, schematic = false): boolean {
  if (!uuid && !reference) throw new Error('KiCad edit operation requires uuid or reference.');
  if (uuid) {
    const safe = uuid.trim().toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(safe)) {
      throw new Error('KiCad uuid must be a canonical UUID.');
    }
    const uuidPattern = new RegExp('\\((?:uuid|tstamp)\\s+' + regexEscape(safe) + '\\)', 'i');
    if (!uuidPattern.test(block)) return false;
  }
  if (reference) {
    const ref = reference.trim();
    if (!/^[A-Za-z][A-Za-z0-9._+-]{0,31}$/.test(ref)) throw new Error('KiCad reference is invalid.');
    const escaped = regexEscape(ref);
    const property = new RegExp('\\(property\\s+"Reference"\\s+"' + escaped + '"(?:\\s|\\))', 'i');
    const instance = schematic ? new RegExp('\\(reference\\s+"' + escaped + '"\\)', 'i') : undefined;
    if (!property.test(block) && !(instance?.test(block))) return false;
  }
  return true;
}

function replaceProperty(block: string, name: string, value: string): { text: string; before: string } {
  const escapedName = regexEscape(name);
  const pattern = new RegExp('(\\(property\\s+"' + escapedName + '"\\s+)("(?:\\\\.|[^"\\\\])*")', 'i');
  const match = block.match(pattern);
  if (!match?.[2]) throw new Error("KiCad property '" + name + "' was not found in selected object.");
  return { text: block.replace(pattern, '$1' + quote(value)), before: unquote(match[2]) };
}

function replaceAt(block: string, x: number, y: number, rotation?: number): { text: string; before: string } {
  for (const value of [x, y, rotation].filter((v): v is number => v !== undefined)) {
    if (!Number.isFinite(value) || Math.abs(value) > 100000) throw new Error('KiCad placement value is out of range.');
  }
  const pattern = /(\(at\s+)(-?\d+(?:\.\d+)?)(\s+)(-?\d+(?:\.\d+)?)(?:\s+(-?\d+(?:\.\d+)?))?(\))/;
  const match = block.match(pattern);
  if (!match) throw new Error('KiCad footprint placement at-clause was not found.');
  const before = match[0];
  const angle = rotation === undefined ? (match[5] ? ' ' + match[5] : '') : ' ' + rotation;
  return { text: block.replace(pattern, '$1' + x + '$3' + y + angle + '$6'), before };
}

function patchOne(
  source: string,
  token: 'symbol' | 'footprint',
  operation: KicadEditOperation,
  mutate: (block: string) => { text: string; before: string }
): { text: string; result: KicadEditPatchResult } {
  const candidates = candidateBlocks(source, token).filter(item =>
    identifierMatches(item.text, operation.uuid, operation.reference, token === 'symbol') &&
    (token !== 'symbol' || item.text.includes('(instances'))
  );
  if (candidates.length !== 1) {
    throw new Error('KiCad edit selector must match exactly one ' + token + '; matched ' + candidates.length + '.');
  }
  const selected = candidates[0]!;
  const changed = mutate(selected.text);
  if (changed.text === selected.text) throw new Error('KiCad edit produced no change.');
  return {
    text: source.slice(0, selected.start) + changed.text + source.slice(selected.end),
    result: {
      operation,
      matched: 1,
      before: changed.before,
      after: operation.kind === 'pcb_footprint_move'
        ? '(at ' + operation.x + ' ' + operation.y + (operation.rotation === undefined ? '' : ' ' + operation.rotation) + ')'
        : operation.value
    }
  };
}

export function patchKicadDocument(source: string, operations: KicadEditOperation[], extension: string) {
  if (Buffer.byteLength(source, 'utf8') > 32 * 1024 * 1024) throw new Error('KiCad source exceeds the 32 MiB editing limit.');
  if (operations.length < 1 || operations.length > 32) throw new Error('KiCad edit requires 1 to 32 operations.');
  const normalizedExtension = extension.toLowerCase();
  if (!['.kicad_sch', '.kicad_pcb'].includes(normalizedExtension)) throw new Error('KiCad edit supports only .kicad_sch and .kicad_pcb files.');

  let text = source;
  const results: KicadEditPatchResult[] = [];
  for (const operation of operations) {
    if (normalizedExtension === '.kicad_sch') {
      if (operation.kind !== 'schematic_symbol_property') throw new Error('Only schematic_symbol_property is valid for .kicad_sch.');
      const patched = patchOne(text, 'symbol', operation, block => replaceProperty(block, operation.property, operation.value));
      text = patched.text;
      results.push(patched.result);
      continue;
    }
    if (operation.kind === 'pcb_footprint_property') {
      const patched = patchOne(text, 'footprint', operation, block => replaceProperty(block, operation.property, operation.value));
      text = patched.text;
      results.push(patched.result);
      continue;
    }
    if (operation.kind === 'pcb_footprint_move') {
      const patched = patchOne(text, 'footprint', operation, block => replaceAt(block, operation.x, operation.y, operation.rotation));
      text = patched.text;
      results.push(patched.result);
      continue;
    }
    throw new Error('Only PCB footprint property/move operations are valid for .kicad_pcb.');
  }
  return { text, results };
}

function firstQuotedProperty(block: string, name: string): string | undefined {
  const pattern = new RegExp('\\(property\\s+"' + regexEscape(name) + '"\\s+("(?:\\\\.|[^"\\\\])*")', 'i');
  const match = block.match(pattern);
  return match?.[1] ? unquote(match[1]) : undefined;
}

function firstUuid(block: string): string | undefined {
  return block.match(/\((?:uuid|tstamp)\s+([0-9a-f-]{36})\)/i)?.[1]?.toLowerCase();
}

function firstAt(block: string): { x: number; y: number; rotation?: number } | undefined {
  const match = block.match(/\(at\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)(?:\s+(-?\d+(?:\.\d+)?))?\)/);
  if (!match?.[1] || !match?.[2]) return undefined;
  return {
    x: Number(match[1]),
    y: Number(match[2]),
    ...(match[3] !== undefined ? { rotation: Number(match[3]) } : {})
  };
}

export function inspectKicadDocument(source: string, extension: string, maxItems = 500) {
  if (Buffer.byteLength(source, 'utf8') > 32 * 1024 * 1024) throw new Error('KiCad source exceeds the 32 MiB inspection limit.');
  if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 2000) throw new Error('KiCad edit inspection maxItems must be 1 to 2000.');
  const normalizedExtension = extension.toLowerCase();
  if (normalizedExtension === '.kicad_sch') {
    const all = candidateBlocks(source, 'symbol')
      .filter(item => item.text.includes('(instances'))
      .map(item => ({
        uuid: firstUuid(item.text),
        reference: firstQuotedProperty(item.text, 'Reference') ?? item.text.match(/\(reference\s+"([^"]+)"\)/i)?.[1],
        value: firstQuotedProperty(item.text, 'Value'),
        footprint: firstQuotedProperty(item.text, 'Footprint'),
        at: firstAt(item.text)
      }))
      .filter(item => item.uuid || item.reference);
    return { kind: 'schematic' as const, sha256: sha256Text(source), itemCount: all.length, items: all.slice(0, maxItems), truncated: all.length > maxItems };
  }
  if (normalizedExtension === '.kicad_pcb') {
    const all = candidateBlocks(source, 'footprint')
      .map(item => ({
        uuid: firstUuid(item.text),
        reference: firstQuotedProperty(item.text, 'Reference'),
        value: firstQuotedProperty(item.text, 'Value'),
        at: firstAt(item.text)
      }))
      .filter(item => item.uuid || item.reference);
    return { kind: 'board' as const, sha256: sha256Text(source), itemCount: all.length, items: all.slice(0, maxItems), truncated: all.length > maxItems };
  }
  throw new Error('KiCad edit inspection supports only .kicad_sch and .kicad_pcb files.');
}

export function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export async function atomicReplace(file: string, content: string): Promise<void> {
  const temp = file + '.rwmcp-' + randomUUID() + '.tmp';
  await fs.writeFile(temp, content, 'utf8');
  await fs.rename(temp, file);
}

export async function createKicadBackup(file: string): Promise<string> {
  const dir = path.join(path.dirname(file), '.rwmcp', 'backups');
  await fs.mkdir(dir, { recursive: true });
  const backup = path.join(dir, path.basename(file) + '.' + Date.now() + '.' + randomUUID() + '.bak');
  await fs.copyFile(file, backup);
  return backup;
}
