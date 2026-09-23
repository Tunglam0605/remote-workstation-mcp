import { createHash } from 'node:crypto';
import path from 'node:path';
import { DOMParser, XMLSerializer, type Document, type Element, type Node } from '@xmldom/xmldom';
import { createOfficeDocumentIdentity, type OfficeDocumentIdentity } from '../common/document-identity.js';
import { readOoxmlPackage, requirePackageEntry, type OoxmlPackage } from '../backends/ooxml/package-reader.js';

const REL_OFFICE_DOCUMENT_SUFFIX = '/officeDocument';
const W14_NS = 'http://schemas.microsoft.com/office/word/2010/wordml';

export interface WordSemanticLocator {
  kind: 'paragraph' | 'table' | 'image' | 'equation' | 'section';
  structuralPath: string;
  stableId?: string;
  textHash?: string;
  bookmarks?: string[];
  relationshipId?: string;
}

export interface WordParagraphAst {
  id: string;
  locator: WordSemanticLocator;
  text: string;
  styleId?: string;
  styleName?: string;
  headingLevel?: number;
}

export interface WordTableAst {
  id: string;
  locator: WordSemanticLocator;
  rows: string[][];
}

export interface WordImageAst {
  id: string;
  locator: WordSemanticLocator;
  relationshipId?: string;
  target?: string;
  external: boolean;
  altText?: string;
}

export interface WordEquationAst {
  id: string;
  locator: WordSemanticLocator;
  text: string;
  omml: string;
}

export interface WordSectionAst {
  id: string;
  locator: WordSemanticLocator;
  type?: string;
  pageSizeTwips?: { width?: number; height?: number; orientation?: string };
}

export interface WordInspectionResult {
  version: 1;
  documentId: string;
  identity: OfficeDocumentIdentity;
  pages: null;
  pageCountReason: 'native-layout-required';
  paragraphs: WordParagraphAst[];
  headings: WordParagraphAst[];
  tables: WordTableAst[];
  images: WordImageAst[];
  equations: WordEquationAst[];
  sections: WordSectionAst[];
  security: {
    macrosPresent: boolean;
    externalRelationships: Array<{ id: string; type: string; target: string }>;
    embeddedObjectsPresent: boolean;
    activeXPresent: boolean;
    remoteTemplatePresent: boolean;
  };
  package: {
    entryCount: number;
    expandedBytes: number;
    mainDocumentPart: string;
    relationshipCount: number;
    warnings: string[];
  };
}

interface Relationship {
  id: string;
  type: string;
  target: string;
  targetMode?: string;
}

function parseXml(bytes: Uint8Array, label: string): Document {
  const text = new TextDecoder('utf-8').decode(bytes);
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) {
    throw new Error(`OOXML_XML_UNSAFE: DTD/entity declaration is not allowed in '${label}'.`);
  }
  const errors: string[] = [];
  const document = new DOMParser({
    onError: error => errors.push(String(error))
  }).parseFromString(text, 'application/xml');
  if (!document || errors.length > 0) {
    throw new Error(`OOXML_XML_INVALID: failed to parse '${label}': ${errors.join('; ').slice(0, 512)}`);
  }
  return document;
}

function descendants(root: Node, localName: string): Element[] {
  const output: Element[] = [];
  const walk = (node: Node): void => {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 1 && (child as Element).localName === localName) output.push(child as Element);
      walk(child);
    }
  };
  walk(root);
  return output;
}

function childElements(root: Node, localName: string): Element[] {
  const output: Element[] = [];
  for (let child = root.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 1 && (child as Element).localName === localName) output.push(child as Element);
  }
  return output;
}

function attr(element: Element, localName: string, namespace?: string): string | undefined {
  const namespaced = namespace ? element.getAttributeNS(namespace, localName) : null;
  if (namespaced) return namespaced;
  for (let index = 0; index < element.attributes.length; index += 1) {
    const item = element.attributes.item(index);
    if (item?.localName === localName && item.value) return item.value;
  }
  return undefined;
}

function normalizedText(root: Node): string {
  const pieces: string[] = [];
  const walk = (node: Node): void => {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.nodeType !== 1) continue;
      const element = child as Element;
      if (element.localName === 't' || element.localName === 'instrText') pieces.push(element.textContent ?? '');
      else if (element.localName === 'tab') pieces.push('\t');
      else if (element.localName === 'br' || element.localName === 'cr') pieces.push('\n');
      else walk(element);
    }
  };
  walk(root);
  return pieces.join('').replace(/[ \t]+/g, ' ').trim();
}

const shortHash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16);

function normalizePartTarget(sourcePart: string, target: string): string {
  if (target.startsWith('/')) return target.replace(/^\/+/, '');
  const base = sourcePart ? path.posix.dirname(sourcePart) : '';
  const normalized = path.posix.normalize(path.posix.join(base, target));
  if (normalized.startsWith('../') || normalized === '..' || path.posix.isAbsolute(normalized)) {
    throw new Error(`OOXML_PACKAGE_INVALID: relationship target escapes package: '${target}'.`);
  }
  return normalized;
}

function relationshipPartName(sourcePart: string): string {
  const dir = path.posix.dirname(sourcePart);
  return (dir === '.' ? '' : `${dir}/`) + `_rels/${path.posix.basename(sourcePart)}.rels`;
}

function parseRelationships(pkg: OoxmlPackage, relPart: string): Relationship[] {
  const bytes = pkg.entries.get(relPart);
  if (!bytes) return [];
  const document = parseXml(bytes, relPart);
  return descendants(document, 'Relationship').map(element => ({
    id: attr(element, 'Id') ?? '',
    type: attr(element, 'Type') ?? '',
    target: attr(element, 'Target') ?? '',
    ...(attr(element, 'TargetMode') ? { targetMode: attr(element, 'TargetMode') } : {})
  })).filter(item => item.id && item.type && item.target);
}

function findMainDocumentPart(pkg: OoxmlPackage): string {
  const relationship = parseRelationships(pkg, '_rels/.rels')
    .find(item => item.type.endsWith(REL_OFFICE_DOCUMENT_SUFFIX));
  if (!relationship || relationship.targetMode === 'External') {
    throw new Error('OOXML_PACKAGE_INVALID: package has no internal officeDocument relationship.');
  }
  return normalizePartTarget('', relationship.target);
}

function parseStyleMap(
  pkg: OoxmlPackage,
  mainPart: string,
  relationships: Relationship[]
): Map<string, { name?: string; headingLevel?: number }> {
  const relationship = relationships.find(item => item.type.endsWith('/styles') && item.targetMode !== 'External');
  if (!relationship) return new Map();
  const stylePart = normalizePartTarget(mainPart, relationship.target);
  const bytes = pkg.entries.get(stylePart);
  if (!bytes) return new Map();
  const document = parseXml(bytes, stylePart);
  const styles = new Map<string, { name?: string; headingLevel?: number }>();

  for (const style of descendants(document, 'style')) {
    if (attr(style, 'type') !== 'paragraph') continue;
    const id = attr(style, 'styleId');
    if (!id) continue;
    const nameElement = descendants(style, 'name')[0];
    const outlineElement = descendants(style, 'outlineLvl')[0];
    const name = nameElement ? attr(nameElement, 'val') : undefined;
    const outline = outlineElement ? Number(attr(outlineElement, 'val')) : Number.NaN;
    let headingLevel: number | undefined;
    if (Number.isInteger(outline) && outline >= 0 && outline <= 8) headingLevel = outline + 1;
    else {
      const match = name?.match(/^heading\s*([1-9])$/i);
      if (match) headingLevel = Number(match[1]);
    }
    styles.set(id, {
      ...(name ? { name } : {}),
      ...(headingLevel ? { headingLevel } : {})
    });
  }
  return styles;
}

function paragraphLocator(paragraph: Element, structuralPath: string): WordSemanticLocator {
  const text = normalizedText(paragraph);
  const paraId = paragraph.getAttributeNS(W14_NS, 'paraId') || attr(paragraph, 'paraId');
  const bookmarks = descendants(paragraph, 'bookmarkStart')
    .map(item => attr(item, 'name'))
    .filter((value): value is string => Boolean(value) && value !== '_GoBack');
  return {
    kind: 'paragraph',
    structuralPath,
    ...(paraId ? { stableId: `w14:paraId:${paraId}` } : {}),
    ...(text ? { textHash: shortHash(text) } : {}),
    ...(bookmarks.length > 0 ? { bookmarks } : {})
  };
}

function nearestParagraph(node: Node): Element | undefined {
  let current: Node | null = node;
  while (current) {
    if (current.nodeType === 1 && (current as Element).localName === 'p') return current as Element;
    current = current.parentNode;
  }
  return undefined;
}

function paragraphStructuralPath(paragraph: Element, allParagraphs: Element[]): string {
  const index = allParagraphs.indexOf(paragraph);
  return index >= 0 ? `document//p[${index + 1}]` : 'document//p[unknown]';
}

function parseParagraphs(
  document: Document,
  styles: Map<string, { name?: string; headingLevel?: number }>
): WordParagraphAst[] {
  return descendants(document, 'p').map((paragraph, index) => {
    const styleElement = descendants(paragraph, 'pStyle')[0];
    const styleId = styleElement ? attr(styleElement, 'val') : undefined;
    const style = styleId ? styles.get(styleId) : undefined;
    const locator = paragraphLocator(paragraph, `document//p[${index + 1}]`);
    return {
      id: locator.stableId ?? `p:${index + 1}:${locator.textHash ?? 'empty'}`,
      locator,
      text: normalizedText(paragraph),
      ...(styleId ? { styleId } : {}),
      ...(style?.name ? { styleName: style.name } : {}),
      ...(style?.headingLevel ? { headingLevel: style.headingLevel } : {})
    };
  });
}

function parseTables(document: Document): WordTableAst[] {
  return descendants(document, 'tbl').map((table, index) => {
    const rows = childElements(table, 'tr').map(row =>
      childElements(row, 'tc').map(cell => normalizedText(cell))
    );
    const textHash = shortHash(rows.flat().join('\u241f'));
    return {
      id: `table:${index + 1}:${textHash}`,
      locator: { kind: 'table', structuralPath: `document//tbl[${index + 1}]`, textHash },
      rows
    };
  });
}

function parseImages(document: Document, mainPart: string, relationships: Relationship[]): WordImageAst[] {
  const byId = new Map(relationships.map(item => [item.id, item]));
  const paragraphs = descendants(document, 'p');
  return descendants(document, 'blip').map((blip, index) => {
    const relationshipId = attr(blip, 'embed') ?? attr(blip, 'link');
    const relationship = relationshipId ? byId.get(relationshipId) : undefined;
    const paragraph = nearestParagraph(blip);
    const external = relationship?.targetMode === 'External';
    const target = relationship
      ? (external ? relationship.target : normalizePartTarget(mainPart, relationship.target))
      : undefined;
    let altText: string | undefined;
    let current: Node | null = blip;
    while (current && !altText) {
      if (current.nodeType === 1) {
        const docPr = descendants(current, 'docPr')[0];
        if (docPr) altText = attr(docPr, 'descr') ?? attr(docPr, 'title') ?? attr(docPr, 'name');
      }
      current = current.parentNode;
    }
    return {
      id: relationshipId ? `image:${relationshipId}` : `image:${index + 1}`,
      locator: {
        kind: 'image',
        structuralPath: paragraph
          ? paragraphStructuralPath(paragraph, paragraphs)
          : `document//blip[${index + 1}]`,
        ...(relationshipId ? { relationshipId } : {})
      },
      ...(relationshipId ? { relationshipId } : {}),
      ...(target ? { target } : {}),
      external,
      ...(altText ? { altText } : {})
    };
  });
}

function parseEquations(document: Document): WordEquationAst[] {
  const serializer = new XMLSerializer();
  const paragraphs = descendants(document, 'p');
  const equationParagraphs = descendants(document, 'oMathPara');
  const standalone = descendants(document, 'oMath').filter(node => {
    let current = node.parentNode;
    while (current) {
      if (current.nodeType === 1 && (current as Element).localName === 'oMathPara') return false;
      current = current.parentNode;
    }
    return true;
  });

  return [...equationParagraphs, ...standalone].map((equation, index) => {
    const paragraph = nearestParagraph(equation);
    const omml = serializer.serializeToString(equation);
    const text = normalizedText(equation);
    const hash = shortHash(omml);
    return {
      id: `equation:${index + 1}:${hash}`,
      locator: {
        kind: 'equation',
        structuralPath: paragraph
          ? paragraphStructuralPath(paragraph, paragraphs)
          : `document//oMath[${index + 1}]`,
        textHash: text ? shortHash(text) : hash
      },
      text,
      omml
    };
  });
}

function parseSections(document: Document): WordSectionAst[] {
  return descendants(document, 'sectPr').map((section, index) => {
    const typeElement = descendants(section, 'type')[0];
    const pageSize = descendants(section, 'pgSz')[0];
    const width = pageSize ? Number(attr(pageSize, 'w')) : Number.NaN;
    const height = pageSize ? Number(attr(pageSize, 'h')) : Number.NaN;
    const orientation = pageSize ? attr(pageSize, 'orient') : undefined;
    const type = typeElement ? attr(typeElement, 'val') : undefined;
    return {
      id: `section:${index + 1}`,
      locator: { kind: 'section', structuralPath: `document//sectPr[${index + 1}]` },
      ...(type ? { type } : {}),
      ...(pageSize ? {
        pageSizeTwips: {
          ...(Number.isFinite(width) ? { width } : {}),
          ...(Number.isFinite(height) ? { height } : {}),
          ...(orientation ? { orientation } : {})
        }
      } : {})
    };
  });
}

function inspectSecurity(pkg: OoxmlPackage, relationships: Relationship[]): WordInspectionResult['security'] {
  const names = [...pkg.entries.keys()];
  const externalRelationships = relationships
    .filter(item => item.targetMode === 'External')
    .map(item => ({ id: item.id, type: item.type, target: item.target }));
  return {
    macrosPresent: names.some(name => /(^|\/)vbaProject\.bin$/i.test(name)),
    externalRelationships,
    embeddedObjectsPresent: names.some(name => /(^|\/)embeddings\//i.test(name)),
    activeXPresent: names.some(name => /(^|\/)activeX\//i.test(name)),
    remoteTemplatePresent: externalRelationships.some(item => /attachedTemplate$/i.test(item.type))
  };
}

export function inspectWordDocx(input: {
  canonicalPath: string;
  bytes: Uint8Array;
  modifiedTimeMs?: number;
}): WordInspectionResult {
  const identity = createOfficeDocumentIdentity(input);
  const pkg = readOoxmlPackage(input.bytes);
  requirePackageEntry(pkg, '[Content_Types].xml');
  requirePackageEntry(pkg, '_rels/.rels');

  const mainPart = findMainDocumentPart(pkg);
  const mainBytes = requirePackageEntry(pkg, mainPart);
  const rootRelationships = parseRelationships(pkg, '_rels/.rels');
  const mainRelationships = parseRelationships(pkg, relationshipPartName(mainPart));
  const styles = parseStyleMap(pkg, mainPart, mainRelationships);
  const document = parseXml(mainBytes, mainPart);
  const paragraphs = parseParagraphs(document, styles);
  const warnings: string[] = [];
  if (paragraphs.some(item => !item.locator.stableId)) {
    warnings.push('Some paragraphs lack w14:paraId; fallback locators use structural path plus text hash.');
  }

  return {
    version: 1,
    documentId: `word:${identity.sha256.slice(0, 24)}`,
    identity,
    pages: null,
    pageCountReason: 'native-layout-required',
    paragraphs,
    headings: paragraphs.filter(item => item.headingLevel !== undefined),
    tables: parseTables(document),
    images: parseImages(document, mainPart, mainRelationships),
    equations: parseEquations(document),
    sections: parseSections(document),
    security: inspectSecurity(pkg, [...rootRelationships, ...mainRelationships]),
    package: {
      entryCount: pkg.manifest.length,
      expandedBytes: pkg.expandedBytes,
      mainDocumentPart: mainPart,
      relationshipCount: rootRelationships.length + mainRelationships.length,
      warnings
    }
  };
}
