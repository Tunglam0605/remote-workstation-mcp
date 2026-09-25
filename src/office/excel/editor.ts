import path from 'node:path';
import { DOMParser, XMLSerializer, type Document, type Element, type Node } from '@xmldom/xmldom';
import { readOoxmlPackage, requirePackageEntry, type OoxmlPackage } from '../backends/ooxml/package-reader.js';
import { writeOoxmlPackage } from '../backends/ooxml/package-writer.js';
import { parseExcelAddress } from './inspector.js';
import { assertExcelFormulaSafe } from './formula-policy.js';

const S_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

export type ExcelPrimitive = string | number | boolean | null;
export type ExcelEditOperation =
  | { type: 'set_cell_value'; sheet: string; cell: string; value: ExcelPrimitive }
  | { type: 'set_cell_formula'; sheet: string; cell: string; formula: string }
  | { type: 'clear_cell'; sheet: string; cell: string }
  | { type: 'set_range_values'; sheet: string; topLeft: string; values: ExcelPrimitive[][] };

export interface ExcelEditResult {
  bytes: Uint8Array;
  applied: Array<{ index: number; type: ExcelEditOperation['type']; target: string }>;
  requiresRecalculation: boolean;
}

interface Relationship { id: string; target: string; targetMode?: string; }

function parseXml(bytes: Uint8Array, label: string): Document {
  const text = new TextDecoder('utf-8').decode(bytes);
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error(`OOXML_XML_UNSAFE: DTD/entity declaration in '${label}'.`);
  const errors: string[] = [];
  const doc = new DOMParser({ onError: error => errors.push(String(error)) }).parseFromString(text, 'application/xml');
  if (!doc || errors.length) throw new Error(`OOXML_XML_INVALID: '${label}': ${errors.join('; ').slice(0, 512)}`);
  return doc;
}

function elements(root: Node, localName: string): Element[] {
  const out: Element[] = [];
  const walk = (node: Node): void => { for (let child = node.firstChild; child; child = child.nextSibling) { if (child.nodeType === 1 && (child as Element).localName === localName) out.push(child as Element); walk(child); } };
  walk(root); return out;
}

function direct(root: Node, localName: string): Element[] {
  const out: Element[] = []; for (let child = root.firstChild; child; child = child.nextSibling) if (child.nodeType === 1 && (child as Element).localName === localName) out.push(child as Element); return out;
}

function attr(element: Element, localName: string, namespace?: string): string | undefined {
  const ns = namespace ? element.getAttributeNS(namespace, localName) : null; if (ns) return ns;
  for (let i = 0; i < element.attributes.length; i += 1) { const item = element.attributes.item(i); if (item?.localName === localName && item.value) return item.value; }
  return undefined;
}

function normalizePart(source: string, target: string): string {
  const normalized = target.startsWith('/')
    ? target.replace(/^\/+/, '')
    : path.posix.normalize(path.posix.join(path.posix.dirname(source), target));
  if (normalized.startsWith('../') || normalized === '..' || path.posix.isAbsolute(normalized)) {
    throw new Error('EXCEL_RELATIONSHIP_UNSAFE: worksheet target escapes package root.');
  }
  return normalized;
}

function workbookRelationships(pkg: OoxmlPackage): Relationship[] {
  const bytes = requirePackageEntry(pkg, 'xl/_rels/workbook.xml.rels');
  const doc = parseXml(bytes, 'xl/_rels/workbook.xml.rels');
  return elements(doc, 'Relationship').map(item => ({ id: attr(item, 'Id') ?? '', target: attr(item, 'Target') ?? '', targetMode: attr(item, 'TargetMode') })).filter(item => item.id && item.target);
}

function sheetMap(pkg: OoxmlPackage, workbookDoc: Document): Map<string, { part: string; element: Element }> {
  const rels = new Map(workbookRelationships(pkg).map(item => [item.id, item]));
  const output = new Map<string, { part: string; element: Element }>();
  for (const sheet of elements(workbookDoc, 'sheet')) {
    const name = attr(sheet, 'name');
    const rid = attr(sheet, 'id', R_NS) ?? attr(sheet, 'id');
    const rel = rid ? rels.get(rid) : undefined;
    if (!name || !rel || rel.targetMode?.toLowerCase() === 'external') continue;
    const part = normalizePart('xl/workbook.xml', rel.target);
    output.set(name, { part, element: sheet });
  }
  return output;
}



function columnLetters(column: number): string {
  let value = column; let out = '';
  while (value > 0) { const rem = (value - 1) % 26; out = String.fromCharCode(65 + rem) + out; value = Math.floor((value - 1) / 26); }
  return out;
}

function address(row: number, column: number): string { return `${columnLetters(column)}${row}`; }

function sheetData(doc: Document): Element {
  const existing = elements(doc, 'sheetData')[0];
  if (existing) return existing;
  const worksheet = doc.documentElement;
  if (!worksheet) throw new Error('EXCEL_PACKAGE_INVALID: worksheet root is missing.');
  const created = doc.createElementNS(S_NS, 'sheetData');
  worksheet.appendChild(created);
  return created;
}

function rowElement(doc: Document, data: Element, rowNumber: number): Element {
  const rows = direct(data, 'row');
  const found = rows.find(row => Number(attr(row, 'r')) === rowNumber);
  if (found) return found;
  const created = doc.createElementNS(S_NS, 'row'); created.setAttribute('r', String(rowNumber));
  const later = rows.find(row => Number(attr(row, 'r')) > rowNumber);
  data.insertBefore(created, later ?? null); return created;
}

function cellElement(doc: Document, row: Element, cellAddress: string): Element {
  const desired = parseExcelAddress(cellAddress);
  const cells = direct(row, 'c');
  const found = cells.find(cell => (attr(cell, 'r') ?? '').toUpperCase() === cellAddress);
  if (found) return found;
  const created = doc.createElementNS(S_NS, 'c'); created.setAttribute('r', cellAddress);
  const later = cells.find(cell => { const raw = attr(cell, 'r'); return raw ? parseExcelAddress(raw).column > desired.column : false; });
  row.insertBefore(created, later ?? null); return created;
}

function clearCellContent(cell: Element): void {
  for (const child of Array.from({ length: cell.childNodes.length }, (_, i) => cell.childNodes.item(i))) if (child) cell.removeChild(child);
  cell.removeAttribute('t');
}

function setPrimitive(doc: Document, cell: Element, value: ExcelPrimitive): void {
  clearCellContent(cell);
  if (value === null) return;
  if (typeof value === 'string') {
    cell.setAttribute('t', 'inlineStr');
    const is = doc.createElementNS(S_NS, 'is'); const t = doc.createElementNS(S_NS, 't');
    if (/^\s|\s$|\s{2,}/.test(value)) t.setAttribute('xml:space', 'preserve');
    t.appendChild(doc.createTextNode(value)); is.appendChild(t); cell.appendChild(is); return;
  }
  const v = doc.createElementNS(S_NS, 'v');
  if (typeof value === 'boolean') { cell.setAttribute('t', 'b'); v.appendChild(doc.createTextNode(value ? '1' : '0')); }
  else {
    if (!Number.isFinite(value)) throw new Error('Excel numeric cell value must be finite.');
    v.appendChild(doc.createTextNode(String(value)));
  }
  cell.appendChild(v);
}

function setFormula(doc: Document, cell: Element, formula: string): void {
  clearCellContent(cell);
  const f = doc.createElementNS(S_NS, 'f'); f.appendChild(doc.createTextNode(assertExcelFormulaSafe(formula))); cell.appendChild(f);
}

function updateDimension(doc: Document, cellAddress: string): void {
  const target = parseExcelAddress(cellAddress);
  let dimension = elements(doc, 'dimension')[0];
  if (!dimension) {
    const root = doc.documentElement;
    if (!root) throw new Error('EXCEL_PACKAGE_INVALID: worksheet root is missing.');
    dimension = doc.createElementNS(S_NS, 'dimension');
    dimension.setAttribute('ref', cellAddress);
    root.insertBefore(dimension, root.firstChild);
    return;
  }
  const raw = dimension.getAttribute('ref') || cellAddress;
  const ends = raw.split(':');
  let first; let last;
  try { first = parseExcelAddress(ends[0]!); last = parseExcelAddress(ends.at(-1)!); }
  catch { dimension.setAttribute('ref', cellAddress); return; }
  const minRow = Math.min(first.row, target.row); const maxRow = Math.max(last.row, target.row);
  const minColumn = Math.min(first.column, target.column); const maxColumn = Math.max(last.column, target.column);
  const firstAddress = address(minRow, minColumn); const lastAddress = address(maxRow, maxColumn);
  dimension.setAttribute('ref', firstAddress === lastAddress ? firstAddress : `${firstAddress}:${lastAddress}`);
}

function applyCell(doc: Document, cellAddress: string, callback: (cell: Element) => void): void {
  const pos = parseExcelAddress(cellAddress);
  const row = rowElement(doc, sheetData(doc), pos.row);
  callback(cellElement(doc, row, cellAddress));
  updateDimension(doc, cellAddress);
}

function markFullCalculation(workbookDoc: Document): void {
  let calcPr = elements(workbookDoc, 'calcPr')[0];
  if (!calcPr) {
    const root = workbookDoc.documentElement;
    if (!root) throw new Error('EXCEL_PACKAGE_INVALID: workbook root is missing.');
    calcPr = workbookDoc.createElementNS(S_NS, 'calcPr'); root.appendChild(calcPr);
  }
  calcPr.setAttribute('calcMode', 'auto'); calcPr.setAttribute('fullCalcOnLoad', '1'); calcPr.setAttribute('forceFullCalc', '1');
}

export function editExcelXlsx(bytes: Uint8Array, operations: ExcelEditOperation[]): ExcelEditResult {
  if (operations.length < 1 || operations.length > 100) throw new Error('Excel edit operation count must be in range 1..100.');
  const pkg = readOoxmlPackage(bytes);
  const workbookBytes = requirePackageEntry(pkg, 'xl/workbook.xml');
  const workbookDoc = parseXml(workbookBytes, 'xl/workbook.xml');
  const sheets = sheetMap(pkg, workbookDoc);
  const sheetDocs = new Map<string, Document>();
  const replacements = new Map<string, Uint8Array>();
  const applied: ExcelEditResult['applied'] = [];
  let totalWrittenCells = 0;
  let requiresRecalculation = false;
  const getSheet = (name: string) => {
    const info = sheets.get(name); if (!info) throw new Error(`EXCEL_SHEET_NOT_FOUND: '${name}'.`);
    let doc = sheetDocs.get(info.part); if (!doc) { doc = parseXml(requirePackageEntry(pkg, info.part), info.part); sheetDocs.set(info.part, doc); }
    return { info, doc };
  };

  operations.forEach((operation, index) => {
    const { doc } = getSheet(operation.sheet);
    if (operation.type === 'set_cell_value') {
      const cell = operation.cell.toUpperCase(); parseExcelAddress(cell); applyCell(doc, cell, target => setPrimitive(doc, target, operation.value)); totalWrittenCells += 1; applied.push({ index, type: operation.type, target: `${operation.sheet}!${cell}` }); return;
    }
    if (operation.type === 'set_cell_formula') {
      const cell = operation.cell.toUpperCase(); parseExcelAddress(cell); applyCell(doc, cell, target => setFormula(doc, target, operation.formula)); totalWrittenCells += 1; requiresRecalculation = true; applied.push({ index, type: operation.type, target: `${operation.sheet}!${cell}` }); return;
    }
    if (operation.type === 'clear_cell') {
      const cell = operation.cell.toUpperCase(); parseExcelAddress(cell); applyCell(doc, cell, clearCellContent); totalWrittenCells += 1; applied.push({ index, type: operation.type, target: `${operation.sheet}!${cell}` }); return;
    }
    const top = parseExcelAddress(operation.topLeft.toUpperCase());
    if (operation.values.length < 1 || operation.values.length > 200 || operation.values.some(row => row.length < 1 || row.length > 200)) throw new Error('Excel range values must be a non-empty matrix up to 200x200.');
    const width = operation.values[0]!.length;
    if (operation.values.some(row => row.length !== width)) throw new Error('Excel range values must be rectangular.');
    const count = operation.values.length * width; totalWrittenCells += count;
    if (totalWrittenCells > 10_000) throw new Error('Excel edit exceeds the 10000-cell mutation limit.');
    operation.values.forEach((rowValues, r) => rowValues.forEach((value, c) => {
      const row = top.row + r; const column = top.column + c;
      if (row > 1_048_576 || column > 16_384) throw new Error('Excel range exceeds worksheet bounds.');
      applyCell(doc, address(row, column), target => setPrimitive(doc, target, value));
    }));
    applied.push({ index, type: operation.type, target: `${operation.sheet}!${operation.topLeft.toUpperCase()}:${address(top.row + operation.values.length - 1, top.column + width - 1)}` });
  });
  if (totalWrittenCells > 10_000) throw new Error('Excel edit exceeds the 10000-cell mutation limit.');
  if (requiresRecalculation) markFullCalculation(workbookDoc);
  const encoder = new TextEncoder();
  replacements.set('xl/workbook.xml', encoder.encode(new XMLSerializer().serializeToString(workbookDoc)));
  for (const [part, doc] of sheetDocs) replacements.set(part, encoder.encode(new XMLSerializer().serializeToString(doc)));
  return { bytes: writeOoxmlPackage(pkg, replacements), applied, requiresRecalculation };
}
