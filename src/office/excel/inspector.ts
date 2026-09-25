import path from 'node:path';
import { DOMParser, type Document, type Element, type Node } from '@xmldom/xmldom';
import { createOfficeDocumentIdentity, type OfficeDocumentIdentity } from '../common/document-identity.js';
import { readOoxmlPackage, requirePackageEntry, type OoxmlPackage } from '../backends/ooxml/package-reader.js';

const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const MAX_SHARED_STRINGS = 200_000;

export interface ExcelCellAst {
  address: string;
  row: number;
  column: number;
  value: string | number | boolean | null;
  valueType: 'string' | 'number' | 'boolean' | 'blank' | 'error';
  formula?: string;
  cachedValue?: string;
  styleIndex?: number;
}

export interface ExcelSheetAst {
  name: string;
  sheetId?: number;
  part: string;
  state?: string;
  dimension?: string;
  cells: ExcelCellAst[];
  totalCells: number;
  formulaCount: number;
  cellsTruncated: boolean;
}

export interface ExcelInspectionResult {
  version: 1;
  documentId: string;
  identity: OfficeDocumentIdentity;
  sheets: ExcelSheetAst[];
  definedNames: Array<{ name: string; value: string; localSheetId?: number; hidden?: boolean }>;
  totals: { sheets: number; cells: number; formulas: number; sharedStrings: number; tables: number };
  security: {
    macrosPresent: boolean;
    externalLinksPresent: boolean;
    externalRelationships: Array<{ id: string; type: string; target: string }>;
    embeddedObjectsPresent: boolean;
    activeXPresent: boolean;
  };
  package: { entryCount: number; expandedBytes: number; workbookPart: string; warnings: string[] };
}

interface Relationship { id: string; type: string; target: string; targetMode?: string; }

function parseXml(bytes: Uint8Array, label: string): Document {
  const text = new TextDecoder('utf-8').decode(bytes);
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error(`OOXML_XML_UNSAFE: DTD/entity declaration is not allowed in '${label}'.`);
  const errors: string[] = [];
  const doc = new DOMParser({ onError: error => errors.push(String(error)) }).parseFromString(text, 'application/xml');
  if (!doc || errors.length) throw new Error(`OOXML_XML_INVALID: '${label}': ${errors.join('; ').slice(0, 512)}`);
  return doc;
}

function elements(root: Node, localName: string): Element[] {
  const out: Element[] = [];
  const walk = (node: Node): void => {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 1 && (child as Element).localName === localName) out.push(child as Element);
      walk(child);
    }
  };
  walk(root);
  return out;
}

function direct(root: Node, localName: string): Element[] {
  const out: Element[] = [];
  for (let child = root.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 1 && (child as Element).localName === localName) out.push(child as Element);
  }
  return out;
}

function attr(element: Element, localName: string, namespace?: string): string | undefined {
  const namespaced = namespace ? element.getAttributeNS(namespace, localName) : null;
  if (namespaced) return namespaced;
  for (let i = 0; i < element.attributes.length; i += 1) {
    const item = element.attributes.item(i);
    if (item?.localName === localName && item.value) return item.value;
  }
  return undefined;
}

function normalizePartTarget(sourcePart: string, target: string): string {
  if (target.startsWith('/')) return target.replace(/^\/+/, '');
  const normalized = path.posix.normalize(path.posix.join(path.posix.dirname(sourcePart), target));
  if (normalized.startsWith('../') || normalized === '..' || path.posix.isAbsolute(normalized)) {
    throw new Error(`OOXML_RELATIONSHIP_UNSAFE: target '${target}' escapes package root.`);
  }
  return normalized;
}

function relationshipPart(sourcePart: string): string {
  return path.posix.join(path.posix.dirname(sourcePart), '_rels', `${path.posix.basename(sourcePart)}.rels`);
}

function relationships(pkg: OoxmlPackage, sourcePart: string): Relationship[] {
  const relPart = relationshipPart(sourcePart);
  const bytes = pkg.entries.get(relPart);
  if (!bytes) return [];
  const doc = parseXml(bytes, relPart);
  return elements(doc, 'Relationship').map(element => ({
    id: attr(element, 'Id') ?? '',
    type: attr(element, 'Type') ?? '',
    target: attr(element, 'Target') ?? '',
    targetMode: attr(element, 'TargetMode')
  })).filter(item => item.id && item.type && item.target);
}

function rootRelationships(pkg: OoxmlPackage): Relationship[] {
  const bytes = requirePackageEntry(pkg, '_rels/.rels');
  const doc = parseXml(bytes, '_rels/.rels');
  return elements(doc, 'Relationship').map(element => ({
    id: attr(element, 'Id') ?? '', type: attr(element, 'Type') ?? '', target: attr(element, 'Target') ?? '', targetMode: attr(element, 'TargetMode')
  })).filter(item => item.id && item.type && item.target);
}

function workbookPart(pkg: OoxmlPackage): string {
  const root = rootRelationships(pkg).find(item => item.type.endsWith('/officeDocument'));
  if (!root) throw new Error('OOXML_PACKAGE_INVALID: officeDocument relationship is missing.');
  const part = normalizePartTarget('', root.target);
  if (!part.startsWith('xl/') || !pkg.entries.has(part)) throw new Error('EXCEL_PACKAGE_INVALID: officeDocument is not an Excel workbook part.');
  return part;
}

function textOf(root: Node): string {
  return elements(root, 't').map(item => item.textContent ?? '').join('');
}

function sharedStrings(pkg: OoxmlPackage): string[] {
  const bytes = pkg.entries.get('xl/sharedStrings.xml');
  if (!bytes) return [];
  const doc = parseXml(bytes, 'xl/sharedStrings.xml');
  const strings = elements(doc, 'si');
  if (strings.length > MAX_SHARED_STRINGS) throw new Error(`EXCEL_PACKAGE_LIMIT: shared strings exceed ${MAX_SHARED_STRINGS}.`);
  return strings.map(item => textOf(item).slice(0, 1_000_000));
}

export function excelColumnNumber(column: string): number {
  if (!/^[A-Z]{1,3}$/.test(column)) throw new Error('Invalid Excel column reference.');
  let value = 0;
  for (const char of column) value = value * 26 + char.charCodeAt(0) - 64;
  if (value < 1 || value > 16384) throw new Error('Excel column reference exceeds XFD.');
  return value;
}

export function parseExcelAddress(address: string): { row: number; column: number } {
  const match = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/.exec(address.toUpperCase());
  if (!match) throw new Error(`Invalid Excel cell address '${address}'.`);
  const row = Number(match[2]);
  if (row > 1_048_576) throw new Error('Excel row reference exceeds 1048576.');
  return { row, column: excelColumnNumber(match[1]!) };
}

function cellValue(cell: Element, strings: string[]): Omit<ExcelCellAst, 'address' | 'row' | 'column' | 'formula' | 'styleIndex'> & { cachedValue?: string } {
  const type = attr(cell, 't');
  const v = direct(cell, 'v')[0]?.textContent ?? '';
  if (type === 'inlineStr') return { value: textOf(direct(cell, 'is')[0] ?? cell), valueType: 'string' };
  if (type === 's') {
    const index = Number(v);
    return { value: Number.isInteger(index) && index >= 0 && index < strings.length ? strings[index]! : '', valueType: 'string', cachedValue: v };
  }
  if (type === 'b') return { value: v === '1', valueType: 'boolean', cachedValue: v };
  if (type === 'e') return { value: v, valueType: 'error', cachedValue: v };
  if (type === 'str') return { value: v, valueType: 'string', cachedValue: v };
  if (!v) return { value: null, valueType: 'blank' };
  const numeric = Number(v);
  return Number.isFinite(numeric) ? { value: numeric, valueType: 'number', cachedValue: v } : { value: v, valueType: 'string', cachedValue: v };
}

function inspectSheet(pkg: OoxmlPackage, part: string, name: string, sheetId: number | undefined, state: string | undefined, strings: string[], maxCells: number): ExcelSheetAst {
  const doc = parseXml(requirePackageEntry(pkg, part), part);
  const dimension = attr(elements(doc, 'dimension')[0] ?? doc.documentElement, 'ref');
  const allCells = elements(doc, 'c');
  let formulas = 0;
  const cells: ExcelCellAst[] = [];
  for (const cell of allCells.slice(0, maxCells)) {
    const address = (attr(cell, 'r') ?? '').toUpperCase();
    if (!address) continue;
    const pos = parseExcelAddress(address);
    const formula = direct(cell, 'f')[0]?.textContent ?? undefined;
    if (formula !== undefined) formulas += 1;
    const styleRaw = attr(cell, 's');
    const styleIndex = styleRaw && /^\d+$/.test(styleRaw) ? Number(styleRaw) : undefined;
    cells.push({ address, ...pos, ...cellValue(cell, strings), ...(formula !== undefined ? { formula: formula.slice(0, 32_768) } : {}), ...(styleIndex !== undefined ? { styleIndex } : {}) });
  }
  if (allCells.length > maxCells) {
    formulas += allCells.slice(maxCells).filter(cell => direct(cell, 'f').length > 0).length;
  }
  return { name, ...(sheetId !== undefined ? { sheetId } : {}), part, ...(state ? { state } : {}), ...(dimension ? { dimension } : {}), cells, totalCells: allCells.length, formulaCount: formulas, cellsTruncated: allCells.length > cells.length };
}

export function inspectExcelWorkbook(input: { canonicalPath: string; bytes: Uint8Array; modifiedTimeMs?: number; maxCellsPerSheet?: number }): ExcelInspectionResult {
  const maxCells = input.maxCellsPerSheet ?? 5000;
  if (!Number.isInteger(maxCells) || maxCells < 1 || maxCells > 50_000) throw new Error('maxCellsPerSheet must be in range 1..50000.');
  const pkg = readOoxmlPackage(input.bytes);
  const workbook = workbookPart(pkg);
  const workbookDoc = parseXml(requirePackageEntry(pkg, workbook), workbook);
  const rels = relationships(pkg, workbook);
  const relMap = new Map(rels.map(item => [item.id, item]));
  const strings = sharedStrings(pkg);
  const sheets: ExcelSheetAst[] = [];
  for (const sheet of elements(workbookDoc, 'sheet').slice(0, 1024)) {
    const name = attr(sheet, 'name') ?? '';
    const id = attr(sheet, 'id', REL_NS) ?? attr(sheet, 'id');
    const relation = id ? relMap.get(id) : undefined;
    if (!name || !relation || relation.targetMode?.toLowerCase() === 'external') continue;
    const part = normalizePartTarget(workbook, relation.target);
    if (!pkg.entries.has(part)) continue;
    const rawSheetId = attr(sheet, 'sheetId');
    sheets.push(inspectSheet(pkg, part, name.slice(0, 31), rawSheetId && /^\d+$/.test(rawSheetId) ? Number(rawSheetId) : undefined, attr(sheet, 'state'), strings, maxCells));
  }
  const definedNames = elements(workbookDoc, 'definedName').slice(0, 5000).map(item => {
    const rawLocal = attr(item, 'localSheetId');
    return {
      name: (attr(item, 'name') ?? '').slice(0, 255),
      value: (item.textContent ?? '').slice(0, 32_768),
      ...(rawLocal && /^\d+$/.test(rawLocal) ? { localSheetId: Number(rawLocal) } : {}),
      ...(attr(item, 'hidden') ? { hidden: attr(item, 'hidden') === '1' } : {})
    };
  }).filter(item => item.name);
  const externalRelationships = [...rootRelationships(pkg), ...rels].filter(item => item.targetMode?.toLowerCase() === 'external').map(item => ({ id: item.id, type: item.type, target: item.target.slice(0, 2048) }));
  const entries = [...pkg.entries.keys()];
  const identity = createOfficeDocumentIdentity({ canonicalPath: input.canonicalPath, bytes: input.bytes, modifiedTimeMs: input.modifiedTimeMs });
  return {
    version: 1,
    documentId: identity.sha256.slice(0, 16),
    identity,
    sheets,
    definedNames,
    totals: { sheets: sheets.length, cells: sheets.reduce((sum, item) => sum + item.totalCells, 0), formulas: sheets.reduce((sum, item) => sum + item.formulaCount, 0), sharedStrings: strings.length, tables: entries.filter(name => /^xl\/tables\/table\d+\.xml$/i.test(name)).length },
    security: {
      macrosPresent: entries.some(name => /(^|\/)vbaProject\.bin$/i.test(name)),
      externalLinksPresent: entries.some(name => name.startsWith('xl/externalLinks/')) || externalRelationships.length > 0,
      externalRelationships,
      embeddedObjectsPresent: entries.some(name => name.startsWith('xl/embeddings/')),
      activeXPresent: entries.some(name => name.startsWith('xl/activeX/'))
    },
    package: { entryCount: pkg.manifest.length, expandedBytes: pkg.expandedBytes, workbookPart: workbook, warnings: sheets.length === 0 ? ['Workbook has no resolved worksheet parts.'] : [] }
  };
}
