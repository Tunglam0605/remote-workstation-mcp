import assert from 'node:assert/strict';
import test from 'node:test';
import { strToU8, zipSync } from 'fflate';
import { editExcelXlsx } from '../src/office/excel/editor.js';
import { inspectExcelWorkbook } from '../src/office/excel/inspector.js';
import { readOoxmlPackage } from '../src/office/backends/ooxml/package-reader.js';

const xml = (value: string) => strToU8(value);
function fixture(): Uint8Array {
  return zipSync({
    '[Content_Types].xml': xml(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`),
    '_rels/.rels': xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    'xl/workbook.xml': xml(`<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`),
    'xl/worksheets/sheet1.xml': xml(`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:B2"/><sheetData><row r="1"><c r="A1" s="7"><v>1</v></c><c r="B1"><v>2</v></c></row><row r="2"><c r="A2"><v>3</v></c></row></sheetData></worksheet>`)
  }, { level: 0 });
}

test('Excel editor applies typed cell/range/formula operations and preserves existing style index', () => {
  const edited = editExcelXlsx(fixture(), [
    { type: 'set_cell_value', sheet: 'Data', cell: 'A1', value: 99 },
    { type: 'set_cell_value', sheet: 'Data', cell: 'C1', value: 'label' },
    { type: 'set_range_values', sheet: 'Data', topLeft: 'B3', values: [[true, 4.5], ['x', null]] },
    { type: 'set_cell_formula', sheet: 'Data', cell: 'D5', formula: '=SUM(A1:B3)' }
  ]);
  assert.equal(edited.requiresRecalculation, true);
  assert.equal(edited.applied.length, 4);
  const inspected = inspectExcelWorkbook({ canonicalPath: 'book.xlsx', bytes: edited.bytes, maxCellsPerSheet: 100 });
  const sheet = inspected.sheets[0]!;
  assert.equal(sheet.cells.find(cell => cell.address === 'A1')?.value, 99);
  assert.equal(sheet.cells.find(cell => cell.address === 'A1')?.styleIndex, 7);
  assert.equal(sheet.cells.find(cell => cell.address === 'C1')?.value, 'label');
  assert.equal(sheet.cells.find(cell => cell.address === 'B3')?.value, true);
  assert.equal(sheet.cells.find(cell => cell.address === 'C3')?.value, 4.5);
  assert.equal(sheet.cells.find(cell => cell.address === 'B4')?.value, 'x');
  assert.equal(sheet.cells.find(cell => cell.address === 'C4')?.value, null);
  assert.equal(sheet.cells.find(cell => cell.address === 'D5')?.formula, 'SUM(A1:B3)');
  assert.equal(sheet.dimension, 'A1:D5');
  const pkg = readOoxmlPackage(edited.bytes);
  const workbookText = new TextDecoder().decode(pkg.entries.get('xl/workbook.xml')!);
  assert.match(workbookText, /calcMode="auto"/);
  assert.match(workbookText, /fullCalcOnLoad="1"/);
});

test('Excel editor clears value/formula content without deleting cell style', () => {
  const first = editExcelXlsx(fixture(), [{ type: 'set_cell_formula', sheet: 'Data', cell: 'A1', formula: 'A2+1' }]);
  const second = editExcelXlsx(first.bytes, [{ type: 'clear_cell', sheet: 'Data', cell: 'A1' }]);
  const cell = inspectExcelWorkbook({ canonicalPath: 'book.xlsx', bytes: second.bytes }).sheets[0]!.cells.find(item => item.address === 'A1');
  assert.equal(cell?.value, null);
  assert.equal(cell?.formula, undefined);
  assert.equal(cell?.styleIndex, 7);
});

test('Excel editor rejects unknown sheets, external-workbook formulas and non-rectangular ranges', () => {
  assert.throws(() => editExcelXlsx(fixture(), [{ type: 'set_cell_value', sheet: 'Missing', cell: 'A1', value: 1 }]), /EXCEL_SHEET_NOT_FOUND/);
  assert.throws(() => editExcelXlsx(fixture(), [{ type: 'set_cell_formula', sheet: 'Data', cell: 'A1', formula: "'[Other.xlsx]Sheet1'!A1" }]), /EXCEL_FORMULA_SIDE_EFFECT_BLOCKED/);
  assert.throws(() => editExcelXlsx(fixture(), [{ type: 'set_cell_formula', sheet: 'Data', cell: 'A1', formula: 'WEBSERVICE("https://example.com")' }]), /external-data-function:WEBSERVICE/);
  assert.throws(() => editExcelXlsx(fixture(), [{ type: 'set_cell_formula', sheet: 'Data', cell: 'A1', formula: 'RTD("server.prog",,"topic")' }]), /external-data-function:RTD/);
  const structured = editExcelXlsx(fixture(), [{ type: 'set_cell_formula', sheet: 'Data', cell: 'A1', formula: 'SUM(Table1[Amount])' }]);
  assert.equal(inspectExcelWorkbook({ canonicalPath: 'book.xlsx', bytes: structured.bytes }).sheets[0]?.cells.find(item => item.address === 'A1')?.formula, 'SUM(Table1[Amount])');
  assert.throws(() => editExcelXlsx(fixture(), [{ type: 'set_range_values', sheet: 'Data', topLeft: 'A1', values: [[1, 2], [3]] }]), /rectangular/);
});
