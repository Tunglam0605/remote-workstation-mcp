import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { strToU8, zipSync } from 'fflate';
import { editWordDocx } from '../src/office/word/editor.js';
import { inspectWordDocx } from '../src/office/word/inspector.js';
import {
  parseOmmlFragment,
  validateOmmlFragment,
  wordLinearTextToOmml
} from '../src/office/word/equation.js';

const xml = (value: string) => strToU8(value);

function docx(): Uint8Array {
  return zipSync({
    '[Content_Types].xml': xml('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    '_rels/.rels': xml('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    'word/document.xml': xml('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"><w:body><w:p w14:paraId="00ABC126"><w:r><w:t>Formula: </w:t></w:r></w:p><w:sectPr/></w:body></w:document>')
  }, { level: 0 });
}

test('Word linear equation text becomes bounded editable OMML markup', () => {
  const omml = wordLinearTextToOmml('x + 1');
  const validated = validateOmmlFragment(omml);
  assert.equal(validated.root, 'oMath');
  assert.equal(validated.text, 'x + 1');
  assert.match(omml, /<m:oMath/);
});

test('Word editor inserts and replaces native OMML nodes without using image equations', () => {
  const firstOmml = wordLinearTextToOmml('x + 1');
  const first = editWordDocx(docx(), [
    { type: 'insert_omml', locator: { paraId: '00ABC126' }, omml: firstOmml, mode: 'append' }
  ]);
  const firstInspection = inspectWordDocx({
    canonicalPath: path.join(process.cwd(), 'equation.docx'),
    bytes: first.bytes
  });
  assert.equal(firstInspection.equations.length, 1);
  assert.equal(firstInspection.equations[0].text, 'x + 1');
  assert.equal(firstInspection.images.length, 0);

  const second = editWordDocx(first.bytes, [
    {
      type: 'replace_equation_omml',
      equationIndex: 1,
      omml: wordLinearTextToOmml('y = 2')
    }
  ]);
  const secondInspection = inspectWordDocx({
    canonicalPath: path.join(process.cwd(), 'equation.docx'),
    bytes: second.bytes
  });
  assert.equal(secondInspection.equations.length, 1);
  assert.equal(secondInspection.equations[0].text, 'y = 2');
});

test('OMML parser rejects unsafe XML and non-Office-Math roots', () => {
  assert.throws(
    () => parseOmmlFragment('<!DOCTYPE x [<!ENTITY p "boom">]><m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">&p;</m:oMath>'),
    /DTD\/entity/
  );
  assert.throws(
    () => parseOmmlFragment('<w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>'),
    /OMML_ROOT_INVALID/
  );
});
