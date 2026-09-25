import path from 'node:path';
import { DOMParser, XMLSerializer, type Document, type Element, type Node } from '@xmldom/xmldom';
import { readOoxmlPackage, requirePackageEntry, type OoxmlPackage } from '../backends/ooxml/package-reader.js';
import { writeOoxmlPackage } from '../backends/ooxml/package-writer.js';

const P_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

export type PowerPointEditOperation =
  | { type: 'set_shape_text'; slideIndex: number; shapeId: number; text: string }
  | { type: 'set_slide_title'; slideIndex: number; text: string };

export interface PowerPointEditResult {
  bytes: Uint8Array;
  applied: Array<{ index: number; type: PowerPointEditOperation['type']; target: string }>;
}

interface Relationship { id: string; target: string; targetMode?: string; }

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

function direct(root: Node, localName: string): Element[] {
  const out: Element[] = [];
  for (let child = root.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 1 && (child as Element).localName === localName) out.push(child as Element);
  }
  return out;
}

function attr(element: Element, name: string, namespace?: string): string | undefined {
  const namespaced = namespace ? element.getAttributeNS(namespace, name) : null;
  if (namespaced) return namespaced;
  for (let i = 0; i < element.attributes.length; i += 1) {
    const item = element.attributes.item(i);
    if (item?.localName === name && item.value) return item.value;
  }
  return undefined;
}

function normalizePart(source: string, target: string): string {
  const normalized = target.startsWith('/')
    ? target.replace(/^\/+/, '')
    : path.posix.normalize(path.posix.join(path.posix.dirname(source), target));
  if (normalized.startsWith('../') || normalized === '..' || path.posix.isAbsolute(normalized)) {
    throw new Error('POWERPOINT_RELATIONSHIP_UNSAFE: slide target escapes package root.');
  }
  return normalized;
}

function relationships(pkg: OoxmlPackage): Relationship[] {
  const doc = parseXml(requirePackageEntry(pkg, 'ppt/_rels/presentation.xml.rels'), 'ppt/_rels/presentation.xml.rels');
  return elements(doc, 'Relationship')
    .map(element => ({ id: attr(element, 'Id') ?? '', target: attr(element, 'Target') ?? '', targetMode: attr(element, 'TargetMode') }))
    .filter(item => item.id && item.target);
}

function slideParts(pkg: OoxmlPackage, presentation: Document): string[] {
  const map = new Map(relationships(pkg).map(item => [item.id, item]));
  return elements(presentation, 'sldId')
    .map(element => {
      const rid = attr(element, 'id', R_NS) ?? attr(element, 'id');
      const relation = rid ? map.get(rid) : undefined;
      return relation && !relation.targetMode ? normalizePart('ppt/presentation.xml', relation.target) : '';
    })
    .filter(part => part && pkg.entries.has(part));
}

function shapeId(shape: Element): number | undefined {
  const nonVisual = elements(shape, 'cNvPr')[0];
  const raw = nonVisual ? attr(nonVisual, 'id') : undefined;
  return raw && /^\d+$/.test(raw) ? Number(raw) : undefined;
}

function isTitle(shape: Element): boolean {
  const placeholder = elements(shape, 'ph')[0];
  const type = placeholder ? attr(placeholder, 'type') : undefined;
  return type === 'title' || type === 'ctrTitle';
}

function validateText(value: string): void {
  if (value.length > 1_000_000 || value.includes('\0')) throw new Error('PowerPoint text exceeds mutation limits or contains NUL.');
  if (value.split('\n').length > 1000) throw new Error('PowerPoint text exceeds the 1000-paragraph limit.');
}

function createSimpleTextBody(doc: Document, shape: Element, lines: string[]): Element {
  const body = doc.createElementNS(P_NS, 'p:txBody');
  body.appendChild(doc.createElementNS(A_NS, 'a:bodyPr'));
  body.appendChild(doc.createElementNS(A_NS, 'a:lstStyle'));
  for (const line of lines) {
    const paragraph = doc.createElementNS(A_NS, 'a:p');
    const run = doc.createElementNS(A_NS, 'a:r');
    const text = doc.createElementNS(A_NS, 'a:t');
    if (/^\s|\s$|\s{2,}/.test(line)) text.setAttribute('xml:space', 'preserve');
    text.appendChild(doc.createTextNode(line));
    run.appendChild(text);
    paragraph.appendChild(run);
    body.appendChild(paragraph);
  }
  shape.appendChild(body);
  return body;
}

function assertSimpleParagraph(paragraph: Element): Element | undefined {
  if (direct(paragraph, 'fld').length || direct(paragraph, 'br').length) {
    throw new Error('POWERPOINT_FORMAT_COMPLEX: fields and manual line breaks are not rewritten by text-only mutation.');
  }
  const runs = direct(paragraph, 'r');
  if (runs.length > 1) throw new Error('POWERPOINT_FORMAT_COMPLEX: mixed-run formatting requires a richer text operation.');
  if (elements(paragraph, 'hlinkClick').length || elements(paragraph, 'hlinkMouseOver').length) {
    throw new Error('POWERPOINT_FORMAT_COMPLEX: hyperlinks are preserved by refusing text replacement on this paragraph.');
  }
  return runs[0];
}

function setRunText(doc: Document, paragraph: Element, run: Element | undefined, value: string): void {
  let targetRun = run;
  if (!targetRun) {
    targetRun = doc.createElementNS(A_NS, 'a:r');
    const endPara = direct(paragraph, 'endParaRPr')[0];
    paragraph.insertBefore(targetRun, endPara ?? null);
  }
  let text = direct(targetRun, 't')[0];
  if (!text) {
    text = doc.createElementNS(A_NS, 'a:t');
    targetRun.appendChild(text);
  }
  while (text.firstChild) text.removeChild(text.firstChild);
  if (/^\s|\s$|\s{2,}/.test(value)) text.setAttribute('xml:space', 'preserve');
  else text.removeAttribute('xml:space');
  text.appendChild(doc.createTextNode(value));
}

function setTextPreservingFormatting(doc: Document, shape: Element, value: string): void {
  validateText(value);
  const lines = value.split('\n');
  const body = direct(shape, 'txBody')[0];
  if (!body) {
    createSimpleTextBody(doc, shape, lines);
    return;
  }
  if (elements(body, 'hlinkClick').length || elements(body, 'hlinkMouseOver').length) {
    throw new Error('POWERPOINT_FORMAT_COMPLEX: shape contains hyperlinks; text mutation is refused to preserve relationship semantics.');
  }
  const paragraphs = direct(body, 'p');
  if (paragraphs.length === 0) {
    for (const line of lines) {
      const paragraph = doc.createElementNS(A_NS, 'a:p');
      setRunText(doc, paragraph, undefined, line);
      body.appendChild(paragraph);
    }
    return;
  }
  if (paragraphs.length !== lines.length) {
    throw new Error(`POWERPOINT_FORMAT_COMPLEX: requested paragraph count ${lines.length} differs from existing ${paragraphs.length}; text-only mutation will not rebuild paragraph structure.`);
  }
  paragraphs.forEach((paragraph, index) => setRunText(doc, paragraph, assertSimpleParagraph(paragraph), lines[index]!));
}

export function editPowerPointPptx(bytes: Uint8Array, operations: PowerPointEditOperation[]): PowerPointEditResult {
  if (operations.length < 1 || operations.length > 100) throw new Error('PowerPoint edit operation count must be in range 1..100.');
  const pkg = readOoxmlPackage(bytes);
  const presentationBytes = requirePackageEntry(pkg, 'ppt/presentation.xml');
  const presentation = parseXml(presentationBytes, 'ppt/presentation.xml');
  const parts = slideParts(pkg, presentation);
  const docs = new Map<string, Document>();
  const applied: PowerPointEditResult['applied'] = [];
  const getSlide = (index: number) => {
    if (!Number.isInteger(index) || index < 1 || index > parts.length) throw new Error(`POWERPOINT_SLIDE_NOT_FOUND: ${index}.`);
    const part = parts[index - 1]!;
    let doc = docs.get(part);
    if (!doc) { doc = parseXml(requirePackageEntry(pkg, part), part); docs.set(part, doc); }
    return { part, doc };
  };
  operations.forEach((operation, index) => {
    const { doc } = getSlide(operation.slideIndex);
    const shapes = elements(doc, 'sp');
    let candidates: Element[];
    if (operation.type === 'set_shape_text') {
      if (!Number.isInteger(operation.shapeId) || operation.shapeId < 1) throw new Error('PowerPoint shapeId must be a positive integer.');
      candidates = shapes.filter(shape => shapeId(shape) === operation.shapeId);
    } else candidates = shapes.filter(isTitle);
    if (candidates.length !== 1) throw new Error(`POWERPOINT_SHAPE_${candidates.length === 0 ? 'NOT_FOUND' : 'AMBIGUOUS'}: operation matched ${candidates.length} shapes.`);
    setTextPreservingFormatting(doc, candidates[0]!, operation.text);
    applied.push({ index, type: operation.type, target: operation.type === 'set_shape_text' ? `slide:${operation.slideIndex}/shape:${operation.shapeId}` : `slide:${operation.slideIndex}/title` });
  });
  const encoder = new TextEncoder();
  const replacements = new Map<string, Uint8Array>();
  for (const [part, doc] of docs) replacements.set(part, encoder.encode(new XMLSerializer().serializeToString(doc)));
  return { bytes: writeOoxmlPackage(pkg, replacements), applied };
}
