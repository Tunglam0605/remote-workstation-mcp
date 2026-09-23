import { createHash } from 'node:crypto';
import { DOMParser, XMLSerializer, type Document, type Element, type Node } from '@xmldom/xmldom';
import { readOoxmlPackage, requirePackageEntry, type OoxmlPackage } from '../backends/ooxml/package-reader.js';
import { writeOoxmlPackage } from '../backends/ooxml/package-writer.js';
import { parseOmmlFragment } from './equation.js';

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const W14_NS = 'http://schemas.microsoft.com/office/word/2010/wordml';

export interface WordParagraphLocatorInput {
  stableId?: string;
  paraId?: string;
  bookmark?: string;
  textHash?: string;
  structuralPath?: string;
}

export type WordEditOperation =
  | { type: 'replace_paragraph_text'; locator: WordParagraphLocatorInput; text: string }
  | { type: 'set_paragraph_style'; locator: WordParagraphLocatorInput; styleId: string }
  | {
      type: 'set_paragraph_format';
      locator: WordParagraphLocatorInput;
      alignment?: 'left' | 'center' | 'right' | 'both';
      leftIndentTwips?: number;
      firstLineTwips?: number;
      spaceBeforeTwips?: number;
      spaceAfterTwips?: number;
    }
  | { type: 'set_table_cell_text'; tableIndex: number; row: number; column: number; text: string }
  | { type: 'remove_image'; relationshipId: string }
  | { type: 'insert_omml'; locator: WordParagraphLocatorInput; omml: string; mode?: 'append' | 'replace-content' }
  | { type: 'replace_equation_omml'; equationIndex: number; omml: string }
  | { type: 'set_section_page_size'; sectionIndex: number; widthTwips: number; heightTwips: number; orientation?: 'portrait' | 'landscape' };

export interface WordEditResult {
  bytes: Uint8Array;
  applied: Array<{ index: number; type: WordEditOperation['type']; target: string }>;
}

function parseXml(bytes: Uint8Array, label: string): Document {
  const text = new TextDecoder().decode(bytes);
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error(`OOXML_XML_UNSAFE: DTD/entity declaration in '${label}'.`);
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

function directElements(root: Node, localName: string): Element[] {
  const out: Element[] = [];
  for (let child = root.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 1 && (child as Element).localName === localName) out.push(child as Element);
  }
  return out;
}

function attr(element: Element, localName: string, namespace?: string): string | undefined {
  const ns = namespace ? element.getAttributeNS(namespace, localName) : null;
  if (ns) return ns;
  for (let i = 0; i < element.attributes.length; i += 1) {
    const item = element.attributes.item(i);
    if (item?.localName === localName && item.value) return item.value;
  }
  return undefined;
}

function text(root: Node): string {
  const parts: string[] = [];
  const walk = (node: Node): void => {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.nodeType !== 1) continue;
      const e = child as Element;
      if (e.localName === 't' || e.localName === 'instrText') parts.push(e.textContent ?? '');
      else if (e.localName === 'tab') parts.push('\t');
      else if (e.localName === 'br' || e.localName === 'cr') parts.push('\n');
      else walk(e);
    }
  };
  walk(root);
  return parts.join('').replace(/[ \t]+/g, ' ').trim();
}

const hashText = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16);

function validateLocator(locator: WordParagraphLocatorInput): void {
  if (!locator.stableId && !locator.paraId && !locator.bookmark && !locator.textHash && !locator.structuralPath) {
    throw new Error('Word paragraph locator requires stableId, paraId, bookmark, textHash, or structuralPath.');
  }
  if (locator.stableId && !/^w14:paraId:[0-9A-Fa-f]{8}$/.test(locator.stableId)) throw new Error('stableId must be w14:paraId:<8 hex>.');
  if (locator.paraId && !/^[0-9A-Fa-f]{8}$/.test(locator.paraId)) throw new Error('paraId must be 8 hex characters.');
  if (locator.textHash && !/^[0-9a-f]{16}$/.test(locator.textHash)) throw new Error('textHash must be 16 lowercase hex characters.');
}

function resolveParagraph(document: Document, locator: WordParagraphLocatorInput): Element {
  validateLocator(locator);
  const paragraphs = elements(document, 'p');
  let candidates = paragraphs;

  if (locator.stableId) {
    const stableParaId = locator.stableId.slice('w14:paraId:'.length);
    candidates = candidates.filter(p => (p.getAttributeNS(W14_NS, 'paraId') || attr(p, 'paraId')) === stableParaId);
  }
  if (locator.paraId) {
    candidates = candidates.filter(p => (p.getAttributeNS(W14_NS, 'paraId') || attr(p, 'paraId')) === locator.paraId);
  }
  if (locator.bookmark) {
    candidates = candidates.filter(p => elements(p, 'bookmarkStart').some(b => attr(b, 'name') === locator.bookmark));
  }
  if (locator.textHash) {
    candidates = candidates.filter(p => hashText(text(p)) === locator.textHash);
  }
  if (locator.structuralPath) {
    const match = locator.structuralPath.match(/^document\/\/p\[(\d+)\]$/);
    if (!match) throw new Error('Unsupported paragraph structuralPath.');
    const target = paragraphs[Number(match[1]) - 1];
    candidates = target && candidates.includes(target) ? [target] : [];
  }

  if (candidates.length !== 1) {
    throw new Error(`WORD_LOCATOR_${candidates.length === 0 ? 'NOT_FOUND' : 'AMBIGUOUS'}: paragraph locator matched ${candidates.length} nodes.`);
  }
  return candidates[0];
}

function ensureChild(parent: Element, localName: string): Element {
  const existing = directElements(parent, localName)[0];
  if (existing) return existing;
  const created = parent.ownerDocument!.createElementNS(W_NS, `w:${localName}`);
  parent.insertBefore(created, parent.firstChild);
  return created;
}

function setWordAttr(element: Element, name: string, value: string): void {
  element.setAttributeNS(W_NS, `w:${name}`, value);
}

function replaceParagraphText(paragraph: Element, value: string): void {
  for (const child of [...Array.from({ length: paragraph.childNodes.length }, (_, index) => paragraph.childNodes.item(index))]) {
    if (child && !(child.nodeType === 1 && (child as Element).localName === 'pPr')) paragraph.removeChild(child);
  }
  const run = paragraph.ownerDocument!.createElementNS(W_NS, 'w:r');
  const textNode = paragraph.ownerDocument!.createElementNS(W_NS, 'w:t');
  if (/^\s|\s$|\s{2,}/.test(value)) textNode.setAttribute('xml:space', 'preserve');
  textNode.appendChild(paragraph.ownerDocument!.createTextNode(value));
  run.appendChild(textNode);
  paragraph.appendChild(run);
}

function setParagraphStyle(paragraph: Element, styleId: string): void {
  if (!/^[A-Za-z0-9_. -]{1,128}$/.test(styleId)) throw new Error('Invalid Word styleId.');
  const pPr = ensureChild(paragraph, 'pPr');
  let pStyle = directElements(pPr, 'pStyle')[0];
  if (!pStyle) {
    pStyle = paragraph.ownerDocument!.createElementNS(W_NS, 'w:pStyle');
    pPr.insertBefore(pStyle, pPr.firstChild);
  }
  setWordAttr(pStyle, 'val', styleId);
}

function setParagraphFormat(paragraph: Element, operation: Extract<WordEditOperation, { type: 'set_paragraph_format' }>): void {
  const pPr = ensureChild(paragraph, 'pPr');
  if (operation.alignment) {
    let jc = directElements(pPr, 'jc')[0];
    if (!jc) { jc = paragraph.ownerDocument!.createElementNS(W_NS, 'w:jc'); pPr.appendChild(jc); }
    setWordAttr(jc, 'val', operation.alignment);
  }
  if (operation.leftIndentTwips !== undefined || operation.firstLineTwips !== undefined) {
    let ind = directElements(pPr, 'ind')[0];
    if (!ind) { ind = paragraph.ownerDocument!.createElementNS(W_NS, 'w:ind'); pPr.appendChild(ind); }
    if (operation.leftIndentTwips !== undefined) setWordAttr(ind, 'left', String(operation.leftIndentTwips));
    if (operation.firstLineTwips !== undefined) setWordAttr(ind, 'firstLine', String(operation.firstLineTwips));
  }
  if (operation.spaceBeforeTwips !== undefined || operation.spaceAfterTwips !== undefined) {
    let spacing = directElements(pPr, 'spacing')[0];
    if (!spacing) { spacing = paragraph.ownerDocument!.createElementNS(W_NS, 'w:spacing'); pPr.appendChild(spacing); }
    if (operation.spaceBeforeTwips !== undefined) setWordAttr(spacing, 'before', String(operation.spaceBeforeTwips));
    if (operation.spaceAfterTwips !== undefined) setWordAttr(spacing, 'after', String(operation.spaceAfterTwips));
  }
}

function setCellText(document: Document, tableIndex: number, row: number, column: number, value: string): void {
  if (![tableIndex, row, column].every(v => Number.isInteger(v) && v >= 1)) {
    throw new Error('tableIndex, row and column are 1-based positive integers.');
  }
  const table = elements(document, 'tbl')[tableIndex - 1];
  if (!table) throw new Error('WORD_TABLE_NOT_FOUND');
  const rowElement = directElements(table, 'tr')[row - 1];
  const cell = rowElement ? directElements(rowElement, 'tc')[column - 1] : undefined;
  if (!cell) throw new Error('WORD_TABLE_CELL_NOT_FOUND');
  let paragraph = directElements(cell, 'p')[0];
  if (!paragraph) {
    paragraph = document.createElementNS(W_NS, 'w:p');
    cell.appendChild(paragraph);
  }
  replaceParagraphText(paragraph, value);
}

function removeImage(document: Document, relationshipId: string): number {
  if (!/^rId[A-Za-z0-9_.-]{1,128}$/.test(relationshipId)) throw new Error('Invalid Word image relationshipId.');
  let removed = 0;
  for (const blip of elements(document, 'blip')) {
    if (attr(blip, 'embed') !== relationshipId && attr(blip, 'link') !== relationshipId) continue;
    let node: Node | null = blip;
    while (node && !(node.nodeType === 1 && (node as Element).localName === 'drawing')) node = node.parentNode;
    if (node?.parentNode) { node.parentNode.removeChild(node); removed += 1; }
  }
  if (removed === 0) throw new Error(`WORD_IMAGE_NOT_FOUND: '${relationshipId}'.`);
  return removed;
}

function importOmml(document: Document, omml: string, allowedRoots: readonly string[]): Element {
  const root = parseOmmlFragment(omml, allowedRoots);
  return document.importNode(root, true) as Element;
}

function insertOmml(
  document: Document,
  paragraph: Element,
  omml: string,
  mode: 'append' | 'replace-content'
): void {
  const equation = importOmml(document, omml, ['oMath']);
  if (mode === 'replace-content') {
    for (const child of [...Array.from({ length: paragraph.childNodes.length }, (_, index) => paragraph.childNodes.item(index))]) {
      if (child && !(child.nodeType === 1 && (child as Element).localName === 'pPr')) paragraph.removeChild(child);
    }
  }
  paragraph.appendChild(equation);
}

function replaceEquation(document: Document, equationIndex: number, omml: string): void {
  if (!Number.isInteger(equationIndex) || equationIndex < 1) throw new Error('equationIndex must be a positive integer.');
  const equations = elements(document, 'oMathPara');
  const standalone = elements(document, 'oMath').filter(node => {
    let current = node.parentNode;
    while (current) {
      if (current.nodeType === 1 && (current as Element).localName === 'oMathPara') return false;
      current = current.parentNode;
    }
    return true;
  });
  const targets = [...equations, ...standalone];
  const target = targets[equationIndex - 1];
  if (!target?.parentNode) throw new Error('WORD_EQUATION_NOT_FOUND');
  const replacement = importOmml(document, omml, [target.localName ?? 'oMath']);
  target.parentNode.replaceChild(replacement, target);
}

function setSectionPageSize(
  document: Document,
  sectionIndex: number,
  widthTwips: number,
  heightTwips: number,
  orientation?: 'portrait' | 'landscape'
): void {
  if (!Number.isInteger(sectionIndex) || sectionIndex < 1) throw new Error('sectionIndex must be a positive integer.');
  for (const value of [widthTwips, heightTwips]) {
    if (!Number.isInteger(value) || value < 1000 || value > 100000) throw new Error('Page size twips must be integer 1000..100000.');
  }
  const section = elements(document, 'sectPr')[sectionIndex - 1];
  if (!section) throw new Error('WORD_SECTION_NOT_FOUND');
  let pgSz = directElements(section, 'pgSz')[0];
  if (!pgSz) { pgSz = document.createElementNS(W_NS, 'w:pgSz'); section.appendChild(pgSz); }
  setWordAttr(pgSz, 'w', String(widthTwips));
  setWordAttr(pgSz, 'h', String(heightTwips));
  if (orientation) setWordAttr(pgSz, 'orient', orientation);
}

function findMainPart(pkg: OoxmlPackage): string {
  const rels = parseXml(requirePackageEntry(pkg, '_rels/.rels'), '_rels/.rels');
  const rel = elements(rels, 'Relationship').find(item => (attr(item, 'Type') ?? '').endsWith('/officeDocument'));
  const target = rel ? attr(rel, 'Target') : undefined;
  if (!target || attr(rel!, 'TargetMode') === 'External') throw new Error('OOXML_PACKAGE_INVALID: no internal main document part.');
  const normalized = target.replace(/^\/+/, '');
  if (normalized.startsWith('../')) throw new Error('OOXML_PACKAGE_INVALID: main document target escapes package.');
  return normalized;
}

export function editWordDocx(bytes: Uint8Array, operations: WordEditOperation[]): WordEditResult {
  if (operations.length < 1 || operations.length > 100) throw new Error('word edit accepts 1..100 operations.');
  const pkg = readOoxmlPackage(bytes);
  const mainPart = findMainPart(pkg);
  const document = parseXml(requirePackageEntry(pkg, mainPart), mainPart);
  const applied: WordEditResult['applied'] = [];

  operations.forEach((operation, index) => {
    switch (operation.type) {
      case 'replace_paragraph_text': {
        const paragraph = resolveParagraph(document, operation.locator);
        replaceParagraphText(paragraph, operation.text);
        applied.push({ index, type: operation.type, target: operation.locator.stableId ?? operation.locator.paraId ?? operation.locator.bookmark ?? operation.locator.structuralPath ?? operation.locator.textHash ?? 'paragraph' });
        break;
      }
      case 'set_paragraph_style': {
        const paragraph = resolveParagraph(document, operation.locator);
        setParagraphStyle(paragraph, operation.styleId);
        applied.push({ index, type: operation.type, target: operation.styleId });
        break;
      }
      case 'set_paragraph_format': {
        const paragraph = resolveParagraph(document, operation.locator);
        setParagraphFormat(paragraph, operation);
        applied.push({ index, type: operation.type, target: operation.locator.stableId ?? operation.locator.paraId ?? operation.locator.structuralPath ?? 'paragraph' });
        break;
      }
      case 'set_table_cell_text':
        setCellText(document, operation.tableIndex, operation.row, operation.column, operation.text);
        applied.push({ index, type: operation.type, target: `table:${operation.tableIndex}/r${operation.row}c${operation.column}` });
        break;
      case 'remove_image': {
        const count = removeImage(document, operation.relationshipId);
        applied.push({ index, type: operation.type, target: `${operation.relationshipId}:${count}` });
        break;
      }
      case 'insert_omml': {
        const paragraph = resolveParagraph(document, operation.locator);
        insertOmml(document, paragraph, operation.omml, operation.mode ?? 'append');
        applied.push({ index, type: operation.type, target: operation.locator.stableId ?? operation.locator.paraId ?? operation.locator.structuralPath ?? 'paragraph' });
        break;
      }
      case 'replace_equation_omml':
        replaceEquation(document, operation.equationIndex, operation.omml);
        applied.push({ index, type: operation.type, target: `equation:${operation.equationIndex}` });
        break;
      case 'set_section_page_size':
        setSectionPageSize(document, operation.sectionIndex, operation.widthTwips, operation.heightTwips, operation.orientation);
        applied.push({ index, type: operation.type, target: `section:${operation.sectionIndex}` });
        break;
    }
  });

  const xml = new XMLSerializer().serializeToString(document);
  const replacements = new Map<string, Uint8Array>([[mainPart, new TextEncoder().encode(xml)]]);
  return { bytes: writeOoxmlPackage(pkg, replacements), applied };
}
