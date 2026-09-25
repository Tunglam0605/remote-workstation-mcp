import assert from 'node:assert/strict';
import test from 'node:test';
import { strToU8, zipSync } from 'fflate';
import { inspectExcelWorkbook, parseExcelAddress } from '../src/office/excel/inspector.js';

const xml = (value: string) => strToU8(value);

function workbook(extra: Record<string, Uint8Array> = {}): Uint8Array {
  return zipSync({
    '[Content_Types].xml': xml(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
      <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
      <Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
      <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
    </Types>`),
    '_rels/.rels': xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
    </Relationships>`),
    'xl/workbook.xml': xml(`<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
      <sheets><sheet name="Data" sheetId="1" r:id="rId1"/><sheet name="Calc" sheetId="2" state="hidden" r:id="rId2"/></sheets>
      <definedNames><definedName name="InputRange">Data!$A$1:$B$2</definedName></definedNames>
    </workbook>`),
    'xl/_rels/workbook.xml.rels': xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
      <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
      <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
    </Relationships>`),
    'xl/sharedStrings.xml': xml(`<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="2" uniqueCount="2"><si><t>Hello</t></si><si><r><t>Rich</t></r><r><t> Text</t></r></si></sst>`),
    'xl/worksheets/sheet1.xml': xml(`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:C3"/><sheetData>
      <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>12.5</v></c><c r="C1" t="b"><v>1</v></c></row>
      <row r="2"><c r="A2" t="inlineStr"><is><t>Inline</t></is></c><c r="B2" s="4"><f>SUM(B1,2)</f><v>14.5</v></c></row>
    </sheetData></worksheet>`),
    'xl/worksheets/sheet2.xml': xml(`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1"/><sheetData><row r="1"><c r="A1" t="s"><v>1</v></c></row></sheetData></worksheet>`),
    'xl/tables/table1.xml': xml(`<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="1" name="Table1" displayName="Table1" ref="A1:B2"/>`),
    ...extra
  }, { level: 0 });
}

test('Excel inspector returns bounded sheets, typed cells, formulas, names and package totals', () => {
  const result = inspectExcelWorkbook({ canonicalPath: 'book.xlsx', bytes: workbook(), maxCellsPerSheet: 10 });
  assert.equal(result.sheets.length, 2);
  assert.equal(result.sheets[0]?.name, 'Data');
  assert.equal(result.sheets[0]?.dimension, 'A1:C3');
  assert.deepEqual(result.sheets[0]?.cells.slice(0, 3).map(cell => cell.value), ['Hello', 12.5, true]);
  const formula = result.sheets[0]?.cells.find(cell => cell.address === 'B2');
  assert.equal(formula?.formula, 'SUM(B1,2)');
  assert.equal(formula?.cachedValue, '14.5');
  assert.equal(formula?.styleIndex, 4);
  assert.equal(result.sheets[0]?.formulaCount, 1);
  assert.equal(result.sheets[1]?.state, 'hidden');
  assert.equal(result.definedNames[0]?.name, 'InputRange');
  assert.equal(result.totals.sharedStrings, 2);
  assert.equal(result.totals.tables, 1);
  assert.equal(result.security.macrosPresent, false);
  assert.equal(result.security.externalLinksPresent, false);
});

test('Excel inspector reports macro/external-link package surfaces without following them', () => {
  const result = inspectExcelWorkbook({ canonicalPath: 'book.xlsm', bytes: workbook({
    'xl/vbaProject.bin': Uint8Array.from([1, 2, 3]),
    'xl/externalLinks/externalLink1.xml': xml('<externalLink xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>')
  }) });
  assert.equal(result.security.macrosPresent, true);
  assert.equal(result.security.externalLinksPresent, true);
});

test('Excel address parser enforces worksheet bounds', () => {
  assert.deepEqual(parseExcelAddress('XFD1048576'), { column: 16384, row: 1048576 });
  assert.throws(() => parseExcelAddress('XFE1'), /exceeds XFD/);
  assert.throws(() => parseExcelAddress('A1048577'), /exceeds 1048576/);
});

test('Excel inspector truncates returned cells while retaining total cell and formula counts', () => {
  const result = inspectExcelWorkbook({ canonicalPath: 'book.xlsx', bytes: workbook(), maxCellsPerSheet: 2 });
  assert.equal(result.sheets[0]?.cells.length, 2);
  assert.equal(result.sheets[0]?.totalCells, 5);
  assert.equal(result.sheets[0]?.formulaCount, 1);
  assert.equal(result.sheets[0]?.cellsTruncated, true);
});


test('Excel inspector reports risky formula candidates even when returned cells are truncated', () => {
  const bytes = workbook({
    'xl/worksheets/sheet1.xml': xml(`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:C1"/><sheetData><row r="1"><c r="A1"><v>1</v></c><c r="B1"><f>WEBSERVICE("https://example.com")</f><v>0</v></c><c r="C1"><f>SUM(A1,1)</f><v>2</v></c></row></sheetData></worksheet>`)
  });
  const result = inspectExcelWorkbook({ canonicalPath: 'book.xlsx', bytes, maxCellsPerSheet: 1 });
  assert.equal(result.sheets[0]?.cells.length, 1);
  assert.equal(result.sheets[0]?.formulaCount, 2);
  assert.equal(result.sheets[0]?.riskyFormulaCount, 1);
  assert.equal(result.security.riskyFormulaCount, 1);
  assert.equal(result.security.riskyFormulaExamples[0]?.address, 'B1');
  assert.equal(result.security.riskyFormulaExamples[0]?.findings[0]?.token, 'WEBSERVICE');
});
