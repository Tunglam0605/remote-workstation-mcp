import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { strToU8, zipSync } from 'fflate';
import { readOoxmlPackage } from '../src/office/backends/ooxml/package-reader.js';
import { editWordDocx } from '../src/office/word/editor.js';
import { inspectWordDocx } from '../src/office/word/inspector.js';

const xml = (value: string) => strToU8(value);

function editableDocx(): Uint8Array {
  return zipSync({
    '[Content_Types].xml': xml(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Default Extension="png" ContentType="image/png"/>
      <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
      <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
    </Types>`),
    '_rels/.rels': xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
    </Relationships>`),
    'word/document.xml': xml(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
      xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"
      xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
      xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
      xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">
      <w:body>
        <w:p w14:paraId="00ABC123"><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Original Heading</w:t></w:r></w:p>
        <w:p w14:paraId="00ABC124"><w:bookmarkStart w:id="0" w:name="BodyAnchor"/><w:r><w:t>Body text</w:t></w:r></w:p>
        <w:p w14:paraId="00ABC125"><w:r><w:drawing><wp:inline><wp:docPr id="1" name="Picture"/><a:graphic><a:graphicData><a:blip r:embed="rIdImage1"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>
        <w:tbl><w:tr><w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
        <w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>
      </w:body>
    </w:document>`),
    'word/styles.xml': xml(`<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style>
      <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style>
    </w:styles>`),
    'word/_rels/document.xml.rels': xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
      <Relationship Id="rIdImage1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>
    </Relationships>`),
    'word/media/image1.png': Uint8Array.from([137,80,78,71,13,10,26,10]),
    'customXml/item1.xml': xml('<custom-preserve value="42"/>')
  }, { level: 0 });
}

test('Word editor applies typed text/style/format/table/media/section operations and preserves unknown parts', () => {
  const original = editableDocx();
  const edited = editWordDocx(original, [
    { type: 'replace_paragraph_text', locator: { paraId: '00ABC123' }, text: 'Edited Heading' },
    { type: 'set_paragraph_style', locator: { paraId: '00ABC123' }, styleId: 'Heading2' },
    {
      type: 'set_paragraph_format',
      locator: { bookmark: 'BodyAnchor' },
      alignment: 'center',
      leftIndentTwips: 240,
      spaceAfterTwips: 120
    },
    { type: 'set_table_cell_text', tableIndex: 1, row: 1, column: 1, text: 'Changed' },
    { type: 'remove_image', relationshipId: 'rIdImage1' },
    { type: 'set_section_page_size', sectionIndex: 1, widthTwips: 16838, heightTwips: 11906, orientation: 'landscape' }
  ]);

  assert.equal(edited.applied.length, 6);
  const inspected = inspectWordDocx({
    canonicalPath: path.join(process.cwd(), 'edited.docx'),
    bytes: edited.bytes
  });

  assert.equal(inspected.headings[0].text, 'Edited Heading');
  assert.equal(inspected.headings[0].headingLevel, 2);
  assert.deepEqual(inspected.tables[0].rows, [['Changed']]);
  assert.equal(inspected.images.length, 0);
  assert.equal(inspected.sections[0].pageSizeTwips?.width, 16838);
  assert.equal(inspected.sections[0].pageSizeTwips?.orientation, 'landscape');

  const originalPkg = readOoxmlPackage(original);
  const editedPkg = readOoxmlPackage(edited.bytes);
  assert.deepEqual(
    [...editedPkg.entries.get('customXml/item1.xml') ?? []],
    [...originalPkg.entries.get('customXml/item1.xml') ?? []]
  );
});

test('Word editor fails closed for missing or ambiguous semantic locators', () => {
  const original = editableDocx();
  assert.throws(
    () => editWordDocx(original, [{ type: 'replace_paragraph_text', locator: { paraId: 'DEADBEEF' }, text: 'x' }]),
    /WORD_LOCATOR_NOT_FOUND/
  );
  assert.throws(
    () => editWordDocx(original, [{ type: 'replace_paragraph_text', locator: {}, text: 'x' }]),
    /requires paraId/
  );
});

test('Word editor bounds operation batches', () => {
  const original = editableDocx();
  assert.throws(() => editWordDocx(original, []), /1\.\.100/);
  const operations = Array.from({ length: 101 }, () => ({
    type: 'replace_paragraph_text' as const,
    locator: { paraId: '00ABC123' },
    text: 'x'
  }));
  assert.throws(() => editWordDocx(original, operations), /1\.\.100/);
});
