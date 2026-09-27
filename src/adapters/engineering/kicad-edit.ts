import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export type KicadEditOperation =
  | { kind: 'schematic_symbol_property'; uuid?: string; reference?: string; property: 'Value' | 'Footprint' | 'Datasheet'; value: string }
  | { kind: 'schematic_symbol_flags'; uuid?: string; reference?: string; inBom?: boolean; onBoard?: boolean }
  | { kind: 'pcb_footprint_property'; uuid?: string; reference?: string; property: 'Value' | 'Reference'; value: string }
  | { kind: 'pcb_footprint_move'; uuid?: string; reference?: string; x: number; y: number; rotation?: number }
  | { kind: 'pcb_footprint_attributes'; uuid?: string; reference?: string; boardOnly?: boolean; excludeFromBom?: boolean; excludeFromPosFiles?: boolean }
  | { kind: 'pcb_footprint_copper'; uuid?: string; reference?: string; clearance?: number; zoneConnect?: 0 | 1 | 2 | 3 };

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

function replaceBooleanToken(block: string, token: 'in_bom' | 'on_board', value: boolean): { text: string; before: string } {
  const pattern = new RegExp('\\(' + token + '\\s+(yes|no)\\)', 'i');
  const match = block.match(pattern);
  if (!match?.[1]) throw new Error('KiCad token ' + token + ' was not found in selected symbol.');
  const next = value ? 'yes' : 'no';
  return { text: block.replace(pattern, '(' + token + ' ' + next + ')'), before: match[1].toLowerCase() };
}

function insertionPoint(block: string): number {
  const markers = ['\n    (attr ', '\n    (fp_', '\n    (pad ', '\n    (zone ', '\n    (group ', '\n    (model '];
  const points = markers.map(marker => block.indexOf(marker)).filter(index => index >= 0);
  return points.length > 0 ? Math.min(...points) : block.lastIndexOf(')');
}

function upsertScalarToken(block: string, token: 'clearance' | 'zone_connect', value: number): { text: string; before?: string } {
  const pattern = new RegExp('\\(' + token + '\\s+(-?\\d+(?:\\.\\d+)?)\\)', 'i');
  const match = block.match(pattern);
  if (match?.[1]) {
    return { text: block.replace(pattern, '(' + token + ' ' + value + ')'), before: match[1] };
  }
  const point = insertionPoint(block);
  if (point < 0) throw new Error('Malformed KiCad footprint block.');
  return {
    text: block.slice(0, point) + '\n    (' + token + ' ' + value + ')' + block.slice(point),
    before: undefined
  };
}

function updateFootprintAttributes(
  block: string,
  options: { boardOnly?: boolean; excludeFromBom?: boolean; excludeFromPosFiles?: boolean }
): { text: string; before: string; after: string } {
  const pattern = /\(attr(?:\s+([^()\r\n]*))?\)/i;
  const match = block.match(pattern);
  const existing = (match?.[1] ?? '').trim().split(/\s+/).filter(Boolean);
  const flags = new Set(existing);
  const apply = (name: string, enabled: boolean | undefined) => {
    if (enabled === undefined) return;
    if (enabled) flags.add(name);
    else flags.delete(name);
  };
  apply('board_only', options.boardOnly);
  apply('exclude_from_bom', options.excludeFromBom);
  apply('exclude_from_pos_files', options.excludeFromPosFiles);
  const allowed = ['smd', 'through_hole', 'board_only', 'exclude_from_pos_files', 'exclude_from_bom'];
  const ordered = allowed.filter(flag => flags.has(flag));
  for (const flag of flags) {
    if (!allowed.includes(flag)) ordered.push(flag);
  }
  const before = match?.[0] ?? '(attr)';
  if (ordered.length === 0) {
    return { text: match ? block.replace(pattern, '') : block, before, after: '(attr)' };
  }
  const next = '(attr ' + ordered.join(' ') + ')';
  if (match) return { text: block.replace(pattern, next), before, after: next };
  const point = insertionPoint(block);
  if (point < 0) throw new Error('Malformed KiCad footprint block.');
  return { text: block.slice(0, point) + '\n    ' + next + block.slice(point), before, after: next };
}

function operationAfter(operation: KicadEditOperation): string {
  if (operation.kind === 'pcb_footprint_move') {
    return '(at ' + operation.x + ' ' + operation.y + (operation.rotation === undefined ? '' : ' ' + operation.rotation) + ')';
  }
  if (operation.kind === 'schematic_symbol_property' || operation.kind === 'pcb_footprint_property') return operation.value;
  if (operation.kind === 'schematic_symbol_flags') {
    return JSON.stringify({ ...(operation.inBom !== undefined ? { inBom: operation.inBom } : {}), ...(operation.onBoard !== undefined ? { onBoard: operation.onBoard } : {}) });
  }
  if (operation.kind === 'pcb_footprint_attributes') {
    return JSON.stringify({
      ...(operation.boardOnly !== undefined ? { boardOnly: operation.boardOnly } : {}),
      ...(operation.excludeFromBom !== undefined ? { excludeFromBom: operation.excludeFromBom } : {}),
      ...(operation.excludeFromPosFiles !== undefined ? { excludeFromPosFiles: operation.excludeFromPosFiles } : {})
    });
  }
  return JSON.stringify({
    ...(operation.clearance !== undefined ? { clearance: operation.clearance } : {}),
    ...(operation.zoneConnect !== undefined ? { zoneConnect: operation.zoneConnect } : {})
  });
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
      after: operationAfter(operation)
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
      if (operation.kind === 'schematic_symbol_property') {
        const patched = patchOne(text, 'symbol', operation, block => replaceProperty(block, operation.property, operation.value));
        text = patched.text;
        results.push(patched.result);
        continue;
      }
      if (operation.kind === 'schematic_symbol_flags') {
        if (operation.inBom === undefined && operation.onBoard === undefined) throw new Error('schematic_symbol_flags requires inBom and/or onBoard.');
        const patched = patchOne(text, 'symbol', operation, block => {
          let next = block;
          const before: Record<string, string> = {};
          if (operation.inBom !== undefined) { const changed = replaceBooleanToken(next, 'in_bom', operation.inBom); next = changed.text; before.inBom = changed.before; }
          if (operation.onBoard !== undefined) { const changed = replaceBooleanToken(next, 'on_board', operation.onBoard); next = changed.text; before.onBoard = changed.before; }
          return { text: next, before: JSON.stringify(before) };
        });
        text = patched.text;
        results.push(patched.result);
        continue;
      }
      throw new Error('Only schematic symbol property/flags operations are valid for .kicad_sch.');
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
    if (operation.kind === 'pcb_footprint_attributes') {
      if (operation.boardOnly === undefined && operation.excludeFromBom === undefined && operation.excludeFromPosFiles === undefined) throw new Error('pcb_footprint_attributes requires at least one attribute flag.');
      const patched = patchOne(text, 'footprint', operation, block => {
        const changed = updateFootprintAttributes(block, operation);
        return { text: changed.text, before: changed.before };
      });
      text = patched.text;
      results.push(patched.result);
      continue;
    }
    if (operation.kind === 'pcb_footprint_copper') {
      if (operation.clearance === undefined && operation.zoneConnect === undefined) throw new Error('pcb_footprint_copper requires clearance and/or zoneConnect.');
      if (operation.clearance !== undefined && (!Number.isFinite(operation.clearance) || operation.clearance < 0 || operation.clearance > 100)) throw new Error('KiCad footprint clearance must be in range 0..100 mm.');
      if (operation.zoneConnect !== undefined && ![0, 1, 2, 3].includes(operation.zoneConnect)) throw new Error('KiCad footprint zoneConnect must be 0..3.');
      const patched = patchOne(text, 'footprint', operation, block => {
        let next = block;
        const before: Record<string, string | undefined> = {};
        if (operation.clearance !== undefined) { const changed = upsertScalarToken(next, 'clearance', operation.clearance); next = changed.text; before.clearance = changed.before; }
        if (operation.zoneConnect !== undefined) { const changed = upsertScalarToken(next, 'zone_connect', operation.zoneConnect); next = changed.text; before.zoneConnect = changed.before; }
        return { text: next, before: JSON.stringify(before) };
      });
      text = patched.text;
      results.push(patched.result);
      continue;
    }
    throw new Error('Unsupported KiCad PCB edit operation.');
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

function firstBooleanToken(block: string, token: 'in_bom' | 'on_board'): boolean | undefined {
  const match = block.match(new RegExp('\\(' + token + '\\s+(yes|no)\\)', 'i'));
  return match?.[1] ? match[1].toLowerCase() === 'yes' : undefined;
}

function firstScalarToken(block: string, token: 'clearance' | 'zone_connect'): number | undefined {
  const match = block.match(new RegExp('\\(' + token + '\\s+(-?\\d+(?:\\.\\d+)?)\\)', 'i'));
  return match?.[1] !== undefined ? Number(match[1]) : undefined;
}

function footprintAttributes(block: string) {
  const match = block.match(/\(attr(?:\s+([^()\r\n]*))?\)/i);
  const flags = new Set((match?.[1] ?? '').trim().split(/\s+/).filter(Boolean));
  return {
    boardOnly: flags.has('board_only'),
    excludeFromBom: flags.has('exclude_from_bom'),
    excludeFromPosFiles: flags.has('exclude_from_pos_files'),
    type: flags.has('smd') ? 'smd' as const : flags.has('through_hole') ? 'through_hole' as const : undefined
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
        datasheet: firstQuotedProperty(item.text, 'Datasheet'),
        inBom: firstBooleanToken(item.text, 'in_bom'),
        onBoard: firstBooleanToken(item.text, 'on_board'),
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
        at: firstAt(item.text),
        attributes: footprintAttributes(item.text),
        clearance: firstScalarToken(item.text, 'clearance'),
        zoneConnect: firstScalarToken(item.text, 'zone_connect')
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
