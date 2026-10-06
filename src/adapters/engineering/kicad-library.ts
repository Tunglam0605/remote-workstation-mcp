import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_LIBRARY_BYTES = 32 * 1024 * 1024;
const MAX_SYMBOLS_PER_LIBRARY = 20_000;
const MAX_SEARCH_LIBRARIES = 512;

export interface KicadLibraryPaths {
  shareRoot: string;
  symbolRoot: string;
  footprintRoot: string;
  blankProjectTemplate: string;
}

export interface KicadSymbolPin {
  number: string;
  name: string;
  electricalType: string;
  shape: string;
  xMm: number;
  yMm: number;
  rotationDeg: number;
  lengthMm: number;
  unit: number;
  bodyStyle: number;
  alternates: string[];
}

export interface KicadResolvedSymbol {
  kind: 'symbol';
  id: string;
  library: string;
  name: string;
  sourcePath: string;
  extendsChain: string[];
  properties: Record<string, string>;
  footprint?: string;
  footprintFilters: string[];
  description?: string;
  keywords?: string;
  pins: KicadSymbolPin[];
  embeddedDefinition: string;
}

export interface KicadFootprintPad {
  number: string;
  type: string;
  shape: string;
  xMm: number;
  yMm: number;
  rotationDeg: number;
  widthMm?: number;
  heightMm?: number;
  drillMm?: number;
  layers: string[];
}

export interface KicadResolvedFootprint {
  kind: 'footprint';
  id: string;
  library: string;
  name: string;
  sourcePath: string;
  description?: string;
  tags?: string;
  attributes: string[];
  pads: KicadFootprintPad[];
  modelPaths: string[];
  source: string;
}

type ChildBlock = { token: string; block: string };
type ParsedSymbolLibrary = { path: string; symbols: Map<string, string> };
const parsedSymbolLibraries = new Map<string, Promise<ParsedSymbolLibrary>>();

function unquote(value: string): string {
  return value.replace(/\\(["\\])/g, '$1');
}

function blockEnd(text: string, start: number): number {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const ch = text[index]!;
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
      if (depth === 0) return index + 1;
      if (depth < 0) break;
    }
  }
  throw new Error('Malformed KiCad S-expression: unbalanced parentheses.');
}

function tokenOf(block: string): string {
  return block.match(/^\(\s*([^\s()]+)/)?.[1] ?? '';
}

function immediateChildren(block: string): ChildBlock[] {
  const children: ChildBlock[] = [];
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < block.length; index += 1) {
    const ch = block[index]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === '(') {
      if (depth === 0) { depth = 1; continue; }
      if (depth === 1) {
        const end = blockEnd(block, index);
        const child = block.slice(index, end);
        children.push({ token: tokenOf(child), block: child });
        index = end - 1;
        continue;
      }
      depth += 1;
      continue;
    }
    if (ch === ')') depth = Math.max(0, depth - 1);
  }
  return children;
}

function allBlocks(text: string, token: string, limit = 100_000): string[] {
  const result: string[] = [];
  const marker = '(' + token;
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf(marker, cursor);
    if (start < 0) break;
    const next = text[start + marker.length] ?? '';
    if (next && !/\s|"/.test(next)) { cursor = start + marker.length; continue; }
    const end = blockEnd(text, start);
    result.push(text.slice(start, end));
    if (result.length > limit) throw new Error(`KiCad library exceeds the ${limit}-block limit for ${token}.`);
    cursor = end;
  }
  return result;
}

function firstQuotedArg(block: string, token: string): string | undefined {
  const escaped = token.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
  const match = block.match(new RegExp('^\\(' + escaped + '\\s+"((?:\\\\.|[^"\\\\])*)"', 'i'));
  return match?.[1] !== undefined ? unquote(match[1]) : undefined;
}

function quotedToken(block: string, token: string): string | undefined {
  const escaped = token.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
  const match = block.match(new RegExp('\\(' + escaped + '\\s+"((?:\\\\.|[^"\\\\])*)"', 'i'));
  return match?.[1] !== undefined ? unquote(match[1]) : undefined;
}

function numberToken(block: string, token: string): number | undefined {
  const escaped = token.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
  const match = block.match(new RegExp('\\(' + escaped + '\\s+(-?\\d+(?:\\.\\d+)?)', 'i'));
  return match?.[1] !== undefined ? Number(match[1]) : undefined;
}

function symbolName(block: string): string | undefined { return firstQuotedArg(block, 'symbol'); }

function property(block: string): { name: string; value: string } | undefined {
  const match = block.match(/^\(property\s+"((?:\\.|[^"\\])*)"\s+"((?:\\.|[^"\\])*)"/);
  if (!match?.[1] || match[2] === undefined) return undefined;
  return { name: unquote(match[1]), value: unquote(match[2]) };
}

function topLevelProperties(block: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const child of immediateChildren(block)) {
    if (child.token !== 'property') continue;
    const parsed = property(child.block);
    if (parsed) result.set(parsed.name, parsed.value);
  }
  return result;
}

async function readBounded(file: string): Promise<string> {
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new Error(`KiCad library path is not a regular file: ${file}`);
  if (stat.size > MAX_LIBRARY_BYTES) throw new Error(`KiCad library exceeds the 32 MiB limit: ${file}`);
  return await fs.readFile(file, 'utf8');
}

async function parseSymbolLibrary(file: string): Promise<ParsedSymbolLibrary> {
  let pending = parsedSymbolLibraries.get(file);
  if (!pending) {
    pending = (async () => {
      const source = await readBounded(file);
      const symbols = new Map<string, string>();
      for (const child of immediateChildren(source)) {
        if (child.token !== 'symbol') continue;
        const name = symbolName(child.block);
        if (!name) continue;
        symbols.set(name, child.block);
        if (symbols.size > MAX_SYMBOLS_PER_LIBRARY) throw new Error(`KiCad symbol library exceeds ${MAX_SYMBOLS_PER_LIBRARY} symbols: ${file}`);
      }
      return { path: file, symbols };
    })();
    parsedSymbolLibraries.set(file, pending);
  }
  return await pending;
}

function splitLibraryId(id: string): { library: string; name: string } {
  const index = id.indexOf(':');
  if (index <= 0 || index >= id.length - 1) throw new Error('KiCad library identifier must use Library:Name.');
  const library = id.slice(0, index);
  const name = id.slice(index + 1);
  if (!/^[A-Za-z0-9_.+-]{1,128}$/.test(library) || !/^[A-Za-z0-9_.+\-()\[\]]{1,192}$/.test(name)) throw new Error('KiCad library identifier contains unsupported characters.');
  return { library, name };
}

function symbolLibraryPath(paths: KicadLibraryPaths, library: string): string { return path.join(paths.symbolRoot, library + '.kicad_sym'); }
function footprintLibraryPath(paths: KicadLibraryPaths, library: string): string { return path.join(paths.footprintRoot, library + '.pretty'); }

function topLevelExtends(block: string): string | undefined {
  const child = immediateChildren(block).find(item => item.token === 'extends');
  return child ? firstQuotedArg(child.block, 'extends') : undefined;
}

function mergeProperties(chain: string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const block of [...chain].reverse()) for (const [name, value] of topLevelProperties(block)) result.set(name, value);
  return result;
}

function propertyBlocks(chain: string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const block of [...chain].reverse()) {
    for (const child of immediateChildren(block)) {
      if (child.token !== 'property') continue;
      const parsed = property(child.block);
      if (parsed) result.set(parsed.name, child.block);
    }
  }
  return result;
}

function flattenSymbolDefinition(library: string, name: string, chain: string[]): string {
  const base = chain[chain.length - 1]!;
  const baseName = symbolName(base) ?? name;
  const effectiveProperties = propertyBlocks(chain);
  const scalarOverlay = new Map<string, string>();
  const nestedByLevel: Array<{ sourceName: string; blocks: string[] }> = [];

  for (const block of [...chain].reverse()) {
    const sourceName = symbolName(block) ?? name;
    const nested: string[] = [];
    for (const child of immediateChildren(block)) {
      if (child.token === 'extends' || child.token === 'property' || child.token === 'embedded_fonts') continue;
      if (child.token === 'symbol') nested.push(child.block);
      else scalarOverlay.set(child.token, child.block);
    }
    if (nested.length) nestedByLevel.push({ sourceName, blocks: nested });
  }

  const selectedNested = nestedByLevel[nestedByLevel.length - 1] ?? { sourceName: baseName, blocks: [] };
  const nested = selectedNested.blocks.map(block => {
    const oldName = symbolName(block);
    if (!oldName) return block;
    const suffix = oldName.startsWith(selectedNested.sourceName) ? oldName.slice(selectedNested.sourceName.length) : '_' + oldName;
    return block.replace(/^\(symbol\s+"((?:\\.|[^"\\])*)"/, `(symbol "${name}${suffix}"`);
  });

  const orderedScalarTokens = ['pin_names', 'pin_numbers', 'exclude_from_sim', 'in_bom', 'on_board', 'in_pos_files', 'duplicate_pin_numbers_are_jumpers', 'power'];
  const scalar: string[] = [];
  for (const token of orderedScalarTokens) {
    const value = scalarOverlay.get(token);
    if (value) scalar.push(value);
  }
  for (const [token, value] of scalarOverlay) if (!orderedScalarTokens.includes(token)) scalar.push(value);

  return [
    `(symbol "${library}:${name}"`,
    ...scalar.map(value => '\t' + value.replace(/\n/g, '\n\t')),
    ...[...effectiveProperties.values()].map(value => '\t' + value.replace(/\n/g, '\n\t')),
    ...nested.map(value => '\t' + value.replace(/\n/g, '\n\t')),
    '\t(embedded_fonts no)',
    ')'
  ].join('\n');
}

function parsePins(definition: string): KicadSymbolPin[] {
  const pins: KicadSymbolPin[] = [];
  for (const child of immediateChildren(definition)) {
    if (child.token !== 'symbol') continue;
    const nestedName = symbolName(child.block) ?? '';
    const suffix = nestedName.match(/_(\d+)_(\d+)$/);
    const unit = suffix?.[1] ? Number(suffix[1]) : 1;
    const bodyStyle = suffix?.[2] ? Number(suffix[2]) : 1;
    for (const pin of allBlocks(child.block, 'pin', 8192)) {
      const header = pin.match(/^\(pin\s+([^\s()]+)\s+([^\s()]+)/);
      const at = pin.match(/\(at\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)(?:\s+(-?\d+(?:\.\d+)?))?\)/);
      const name = quotedToken(pin, 'name') ?? '';
      const number = quotedToken(pin, 'number') ?? '';
      if (!header?.[1] || !header[2] || !at?.[1] || !at[2] || !number) continue;
      const alternates = [...pin.matchAll(/\(alternate\s+"((?:\\.|[^"\\])*)"/g)].map(match => match[1] ? unquote(match[1]) : '').filter(Boolean);
      pins.push({
        number,
        name,
        electricalType: header[1],
        shape: header[2],
        xMm: Number(at[1]),
        yMm: Number(at[2]),
        rotationDeg: Number(at[3] ?? 0),
        lengthMm: numberToken(pin, 'length') ?? 0,
        unit,
        bodyStyle,
        alternates
      });
    }
  }
  const unique = new Map<string, KicadSymbolPin>();
  for (const pin of pins) unique.set(`${pin.unit}\u0000${pin.bodyStyle}\u0000${pin.number}`, pin);
  return [...unique.values()].sort((a, b) => a.unit - b.unit || a.number.localeCompare(b.number, undefined, { numeric: true }));
}

function splitFilters(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(/\s+/).map(value => value.trim()).filter(Boolean).slice(0, 64);
}

export function defaultKicadLibraryPaths(cliPath: string): KicadLibraryPaths {
  const installRoot = path.dirname(path.dirname(cliPath));
  const shareRoot = path.join(installRoot, 'share', 'kicad');
  return {
    shareRoot,
    symbolRoot: path.join(shareRoot, 'symbols'),
    footprintRoot: path.join(shareRoot, 'footprints'),
    blankProjectTemplate: path.join(shareRoot, 'template', 'kicad.kicad_pro')
  };
}

export async function resolveKicadSymbol(paths: KicadLibraryPaths, id: string): Promise<KicadResolvedSymbol> {
  const { library, name } = splitLibraryId(id);
  const sourcePath = symbolLibraryPath(paths, library);
  const parsed = await parseSymbolLibrary(sourcePath);
  const chain: string[] = [];
  const names: string[] = [];
  const seen = new Set<string>();
  let current = name;
  for (let depth = 0; depth < 16; depth += 1) {
    if (seen.has(current)) throw new Error(`KiCad symbol inheritance cycle detected at ${library}:${current}.`);
    seen.add(current);
    const block = parsed.symbols.get(current);
    if (!block) throw new Error(`KiCad symbol not found: ${library}:${current}.`);
    chain.push(block);
    names.push(current);
    const parent = topLevelExtends(block);
    if (!parent) break;
    current = parent;
  }
  if (topLevelExtends(chain[chain.length - 1]!)) throw new Error('KiCad symbol inheritance exceeds 16 levels.');

  const properties = mergeProperties(chain);
  const embeddedDefinition = flattenSymbolDefinition(library, name, chain);
  const pins = parsePins(embeddedDefinition);
  return {
    kind: 'symbol',
    id: `${library}:${name}`,
    library,
    name,
    sourcePath,
    extendsChain: names,
    properties: Object.fromEntries(properties),
    ...(properties.get('Footprint') ? { footprint: properties.get('Footprint') } : {}),
    footprintFilters: splitFilters(properties.get('ki_fp_filters')),
    ...(properties.get('Description') ? { description: properties.get('Description') } : {}),
    ...(properties.get('ki_keywords') ? { keywords: properties.get('ki_keywords') } : {}),
    pins,
    embeddedDefinition
  };
}

function wildcardToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp('^' + escaped + '$', 'i');
}

export function footprintMatchesFilters(footprintId: string, filters: string[]): boolean | undefined {
  if (!filters.length) return undefined;
  const name = footprintId.includes(':') ? footprintId.slice(footprintId.indexOf(':') + 1) : footprintId;
  return filters.some(filter => {
    const regex = wildcardToRegex(filter);
    return regex.test(footprintId) || regex.test(name);
  });
}

export async function resolveKicadFootprint(paths: KicadLibraryPaths, id: string): Promise<KicadResolvedFootprint> {
  const { library, name } = splitLibraryId(id);
  const sourcePath = path.join(footprintLibraryPath(paths, library), name + '.kicad_mod');
  const source = await readBounded(sourcePath);
  const headerName = firstQuotedArg(source, 'footprint');
  if (!headerName) throw new Error(`KiCad footprint is malformed: ${id}.`);
  const description = quotedToken(source, 'descr');
  const tags = quotedToken(source, 'tags');
  const attr = source.match(/\(attr(?:\s+([^()\r\n]*))?\)/i)?.[1] ?? '';
  const pads: KicadFootprintPad[] = [];
  for (const pad of allBlocks(source, 'pad', 8192)) {
    const header = pad.match(/^\(pad\s+"((?:\\.|[^"\\])*)"\s+([^\s()]+)\s+([^\s()]+)/);
    const at = pad.match(/\(at\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)(?:\s+(-?\d+(?:\.\d+)?))?\)/);
    if (!header?.[1] || !header[2] || !header[3] || !at?.[1] || !at[2]) continue;
    const size = pad.match(/\(size\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\)/);
    const drill = pad.match(/\(drill(?:\s+oval)?\s+(-?\d+(?:\.\d+)?)/);
    const layersBlock = pad.match(/\(layers\s+([^\r\n()]+)\)/)?.[1] ?? '';
    const layers = [...layersBlock.matchAll(/"([^"]+)"/g)].map(match => match[1]!).slice(0, 32);
    pads.push({
      number: unquote(header[1]),
      type: header[2],
      shape: header[3],
      xMm: Number(at[1]),
      yMm: Number(at[2]),
      rotationDeg: Number(at[3] ?? 0),
      ...(size?.[1] ? { widthMm: Number(size[1]) } : {}),
      ...(size?.[2] ? { heightMm: Number(size[2]) } : {}),
      ...(drill?.[1] ? { drillMm: Number(drill[1]) } : {}),
      layers
    });
  }
  const modelPaths = allBlocks(source, 'model', 256).map(block => firstQuotedArg(block, 'model')).filter((value): value is string => Boolean(value));
  return {
    kind: 'footprint',
    id: `${library}:${name}`,
    library,
    name,
    sourcePath,
    ...(description ? { description } : {}),
    ...(tags ? { tags } : {}),
    attributes: attr.split(/\s+/).filter(Boolean),
    pads,
    modelPaths,
    source
  };
}

function scoreText(query: string, id: string, name: string, description = '', keywords = ''): number {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return 0;
  const tokens = normalized.split(/\s+/).filter(Boolean);
  const idLc = id.toLowerCase();
  const nameLc = name.toLowerCase();
  const haystack = `${idLc} ${description.toLowerCase()} ${keywords.toLowerCase()}`;
  let score = 0;
  if (nameLc === normalized || idLc === normalized) score += 1000;
  if (nameLc.startsWith(normalized)) score += 500;
  if (nameLc.includes(normalized)) score += 300;
  for (const token of tokens) {
    if (nameLc.includes(token)) score += 100;
    else if (idLc.includes(token)) score += 80;
    else if (haystack.includes(token)) score += 20;
    else return 0;
  }
  return score;
}

export async function searchKicadSymbols(paths: KicadLibraryPaths, query: string, limit: number) {
  const entries = await fs.readdir(paths.symbolRoot, { withFileTypes: true });
  const results: Array<Record<string, unknown> & { score: number }> = [];
  let scannedLibraries = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.kicad_sym')) continue;
    scannedLibraries += 1;
    if (scannedLibraries > MAX_SEARCH_LIBRARIES) break;
    const library = entry.name.slice(0, -'.kicad_sym'.length);
    const parsed = await parseSymbolLibrary(path.join(paths.symbolRoot, entry.name));
    for (const [name, block] of parsed.symbols) {
      const props = topLevelProperties(block);
      const id = `${library}:${name}`;
      const score = scoreText(query, id, name, props.get('Description') ?? '', props.get('ki_keywords') ?? '');
      if (score <= 0) continue;
      results.push({
        score,
        kind: 'symbol',
        id,
        library,
        name,
        ...(props.get('Description') ? { description: props.get('Description') } : {}),
        ...(props.get('Footprint') ? { footprint: props.get('Footprint') } : {}),
        footprintFilters: splitFilters(props.get('ki_fp_filters')),
        ...(topLevelExtends(block) ? { extends: topLevelExtends(block) } : {})
      });
    }
  }
  return results.sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id))).slice(0, limit).map(({ score: _score, ...result }) => result);
}

export async function searchKicadFootprints(paths: KicadLibraryPaths, query: string, limit: number) {
  const libraries = await fs.readdir(paths.footprintRoot, { withFileTypes: true });
  const raw: Array<{ id: string; library: string; name: string; score: number }> = [];
  let scannedLibraries = 0;
  for (const libraryEntry of libraries) {
    if (!libraryEntry.isDirectory() || !libraryEntry.name.endsWith('.pretty')) continue;
    scannedLibraries += 1;
    if (scannedLibraries > MAX_SEARCH_LIBRARIES) break;
    const library = libraryEntry.name.slice(0, -'.pretty'.length);
    const dir = path.join(paths.footprintRoot, libraryEntry.name);
    const files = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of files) {
      if (!entry.isFile() || !entry.name.endsWith('.kicad_mod')) continue;
      const name = entry.name.slice(0, -'.kicad_mod'.length);
      const id = `${library}:${name}`;
      const score = scoreText(query, id, name);
      if (score > 0) raw.push({ id, library, name, score });
    }
  }
  const candidates = raw.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, Math.min(64, limit * 4));
  const enriched = [];
  for (const candidate of candidates) {
    const resolved = await resolveKicadFootprint(paths, candidate.id);
    const refined = candidate.score + scoreText(query, candidate.id, candidate.name, resolved.description ?? '', resolved.tags ?? '');
    enriched.push({
      score: refined,
      kind: 'footprint',
      id: candidate.id,
      library: candidate.library,
      name: candidate.name,
      ...(resolved.description ? { description: resolved.description } : {}),
      ...(resolved.tags ? { tags: resolved.tags } : {}),
      padCount: resolved.pads.length,
      modelCount: resolved.modelPaths.length,
      attributes: resolved.attributes
    });
  }
  return enriched.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit).map(({ score: _score, ...result }) => result);
}
