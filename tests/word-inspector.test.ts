import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { strToU8, zipSync } from 'fflate';
import { inspectWordDocx } from '../src/office/word/inspector.js';
import { inspectZipCentralDirectory } from '../src/office/backends/ooxml/package-reader.js';

function xml(value: string): Uint8Array {
  return strToU8(value);
}

function fixtureDocx(): Uint8Array {
  return zipSync({
    '[Content_Types].xml': xml(`<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`),
    '_rels/.rels': xml(`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`),
    'word/document.xml': xml(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
 xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
 xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
 xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
 xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">
 <w:body>
  <w:p w14:paraId="00ABC123"><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Office Pack Test</w:t></w:r></w:p>
  <w:p><w:bookmarkStart w:id="0" w:name="EquationAnchor"/><w:r><w:t>Equation: </w:t></w:r>
    <m:oMath><m:r><m:t>x+1</m:t></m:r></m:oMath>
  </w:p>
  <w:p><w:r><w:drawing><wp:inline><wp:docPr id="1" name="Picture 1" descr="Equation screenshot"/><a:graphic><a:graphicData><a:blip r:embed="rIdImage1"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>
  <w:tbl><w:tr><w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
  <w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>
 </w:body>
</w:document>`),
    'word/styles.xml': xml(`<?xml version="1.0" encoding="UTF-8"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
 <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style>
</w:styles>`),
    'word/_rels/document.xml.rels': xml(`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
 <Relationship Id="rIdImage1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>
 <Relationship Id="rIdExternal" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.invalid/" TargetMode="External"/>
 <Relationship Id="rIdTemplate" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" Target="https://example.invalid/template.dotm" TargetMode="External"/>
</Relationships>`),
    'word/media/image1.png': Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])
  }, { level: 0 });
}

test('Word Inspector returns stable structural AST for heading, table, image, equation and section', () => {
  const bytes = fixtureDocx();
  const result = inspectWordDocx({
    canonicalPath: path.join(process.cwd(), 'fixture.docx'),
    bytes,
    modifiedTimeMs: 1234
  });

  assert.equal(result.version, 1);
  assert.equal(result.package.mainDocumentPart, 'word/document.xml');
  assert.equal(result.pages, null);
  assert.equal(result.pageCountReason, 'native-layout-required');

  assert.equal(result.headings.length, 1);
  assert.equal(result.headings[0].text, 'Office Pack Test');
  assert.equal(result.headings[0].headingLevel, 1);
  assert.equal(result.headings[0].locator.stableId, 'w14:paraId:00ABC123');

  assert.equal(result.tables.length, 1);
  assert.deepEqual(result.tables[0].rows, [['A1', 'B1']]);

  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].relationshipId, 'rIdImage1');
  assert.equal(result.images[0].target, 'word/media/image1.png');
  assert.equal(result.images[0].altText, 'Equation screenshot');

  assert.equal(result.equations.length, 1);
  assert.equal(result.equations[0].text, 'x+1');
  assert.match(result.equations[0].omml, /oMath/);

  assert.equal(result.sections.length, 1);
  assert.equal(result.sections[0].pageSizeTwips?.width, 11906);
  assert.equal(result.security.externalRelationships.length, 2);
  assert.equal(result.security.remoteTemplatePresent, true);
  assert.equal(result.security.macrosPresent, false);
});

test('Word Inspector reports fallback locator warning when paragraphs lack w14:paraId', () => {
  const result = inspectWordDocx({
    canonicalPath: path.join(process.cwd(), 'fixture.docx'),
    bytes: fixtureDocx()
  });
  assert.ok(result.package.warnings.some(item => item.includes('lack w14:paraId')));
  assert.ok(result.paragraphs.some(item => !item.locator.stableId && Boolean(item.locator.textHash)));
});

test('OOXML package preflight rejects path traversal before inflate', () => {
  const malicious = zipSync({ '../escape.xml': xml('<x/>') }, { level: 0 });
  assert.throws(() => inspectZipCentralDirectory(malicious), /unsafe ZIP entry name/);
});

test('OOXML package preflight rejects OLE compound/encrypted-style containers', () => {
  const cfb = Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
  assert.throws(() => inspectZipCentralDirectory(cfb), /OFFICE_ENCRYPTED_OR_LEGACY_CONTAINER/);
});
