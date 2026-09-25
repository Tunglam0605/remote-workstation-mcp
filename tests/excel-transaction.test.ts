import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { strToU8, zipSync } from 'fflate';
import { sha256Bytes } from '../src/office/common/document-identity.js';
import { inspectExcelWorkbook } from '../src/office/excel/inspector.js';
import { rollbackExcelTransaction, transactionalExcelEdit } from '../src/office/excel/transactional-edit.js';

const OWNER = 'test-principal';
const SESSION = '11111111-1111-4111-8111-111111111111';
const xml = (value: string) => strToU8(value);
function xlsx(extra: Record<string, Uint8Array> = {}): Uint8Array {
  return zipSync({
    '[Content_Types].xml': xml(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`),
    '_rels/.rels': xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    'xl/workbook.xml': xml(`<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`),
    'xl/worksheets/sheet1.xml': xml(`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:B2"/><sheetData><row r="1"><c r="A1"><v>1</v></c><c r="B1"><f>A1+1</f><v>2</v></c></row></sheetData></worksheet>`),
    ...extra
  }, { level: 0 });
}
async function tempWorkbook(extra: Record<string, Uint8Array> = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-excel-tx-')); const file = path.join(dir, 'book.xlsx'); const stateRoot = path.join(dir, 'state'); const original = xlsx(extra); await fs.writeFile(file, original); return { dir, file, stateRoot, original };
}

test('transactional Excel edit commits after structural/native acceptance and rollback restores exact original', async t => {
  const fixture = await tempWorkbook(); t.after(async () => fs.rm(fixture.dir, { recursive: true, force: true }));
  let nativeCalls = 0;
  const nativeAdapter = {
    supported: () => true,
    validateAndRender: async (workbookPath: string, pdfPath: string) => {
      nativeCalls += 1; const inspection = inspectExcelWorkbook({ canonicalPath: workbookPath, bytes: await fs.readFile(workbookPath) }); assert.equal(inspection.sheets[0]?.cells.find(cell => cell.address === 'A2')?.value, 10); await fs.writeFile(pdfPath, Buffer.from('%PDF-1.7\nexcel\n')); return { ok: true, excelVersion: 'test', sheets: 1, formulaErrors: 0, calculationState: 0, pdfPath };
    }
  };
  const originalSha = sha256Bytes(fixture.original);
  const applied = await transactionalExcelEdit({
    canonicalPath: fixture.file, principalId: OWNER, workSessionId: SESSION, stateRoot: fixture.stateRoot, expectedSha256: originalSha, maxWriteBytes: 10_000_000,
    nativeAdapter, operations: [{ type: 'set_cell_value', sheet: 'Data', cell: 'A2', value: 10 }, { type: 'set_cell_formula', sheet: 'Data', cell: 'B2', formula: 'A2*2' }],
    acceptance: { nativeExcel: true, recalculate: true, exportPdf: true, preserveSheetNames: ['Data'], minFormulaCount: 2, maxFormulaErrors: 0 }
  });
  assert.equal(applied.transaction.state, 'committed'); assert.equal(applied.transaction.validation?.passed, true); assert.equal(applied.requiresRecalculation, true); assert.equal(nativeCalls, 1); assert.notEqual(applied.committedIdentity.sha256, originalSha); assert.equal(sha256Bytes(await fs.readFile(applied.backupPath)), originalSha);
  const rollback = await rollbackExcelTransaction({ canonicalPath: fixture.file, transactionId: applied.transaction.id, principalId: OWNER, workSessionId: SESSION, stateRoot: fixture.stateRoot });
  assert.equal(rollback.alreadyRestored, false); assert.equal(rollback.restoredIdentity.sha256, originalSha);
  const second = await rollbackExcelTransaction({ canonicalPath: fixture.file, transactionId: applied.transaction.id, principalId: OWNER, workSessionId: SESSION, stateRoot: fixture.stateRoot }); assert.equal(second.alreadyRestored, true);
});

test('failed Excel native formula-error acceptance leaves original byte-identical', async t => {
  const fixture = await tempWorkbook(); t.after(async () => fs.rm(fixture.dir, { recursive: true, force: true })); const originalSha = sha256Bytes(fixture.original);
  await assert.rejects(transactionalExcelEdit({
    canonicalPath: fixture.file, principalId: OWNER, workSessionId: SESSION, stateRoot: fixture.stateRoot,
    nativeAdapter: { supported: () => true, validateAndRender: async () => ({ ok: true, sheets: 1, formulaErrors: 2, calculationState: 0 }) },
    operations: [{ type: 'set_cell_value', sheet: 'Data', cell: 'A1', value: 5 }], acceptance: { nativeExcel: true, maxFormulaErrors: 0 }
  }), /OFFICE_ACCEPTANCE_FAILED/);
  assert.equal(sha256Bytes(await fs.readFile(fixture.file)), originalSha);
});

test('Excel transaction rejects stale SHA and unsafe active/external content before mutation state', async t => {
  const fixture = await tempWorkbook(); t.after(async () => fs.rm(fixture.dir, { recursive: true, force: true }));
  await assert.rejects(transactionalExcelEdit({ canonicalPath: fixture.file, principalId: OWNER, workSessionId: SESSION, stateRoot: fixture.stateRoot, expectedSha256: '0'.repeat(64), operations: [{ type: 'set_cell_value', sheet: 'Data', cell: 'A1', value: 2 }], acceptance: { nativeExcel: false } }), /OFFICE_CONFLICT/);
  await assert.rejects(fs.stat(fixture.stateRoot), /ENOENT/);

  const unsafe = await tempWorkbook({ 'xl/externalLinks/externalLink1.xml': xml('<externalLink xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>') }); t.after(async () => fs.rm(unsafe.dir, { recursive: true, force: true }));
  await assert.rejects(transactionalExcelEdit({ canonicalPath: unsafe.file, principalId: OWNER, workSessionId: SESSION, stateRoot: unsafe.stateRoot, operations: [{ type: 'set_cell_value', sheet: 'Data', cell: 'A1', value: 2 }], acceptance: { nativeExcel: false } }), /OFFICE_EXTERNAL_CONTENT_BLOCKED/);
  await assert.rejects(fs.stat(unsafe.stateRoot), /ENOENT/);
});

test('native Excel acceptance is blocked before COM when an existing formula can perform external side effects', async t => {
  const fixture = await tempWorkbook({
    'xl/worksheets/sheet1.xml': xml(`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:B1"/><sheetData><row r="1"><c r="A1"><v>1</v></c><c r="B1"><f>WEBSERVICE("https://example.com")</f><v>0</v></c></row></sheetData></worksheet>`)
  });
  t.after(async () => fs.rm(fixture.dir, { recursive: true, force: true }));
  let nativeCalls = 0;
  await assert.rejects(transactionalExcelEdit({
    canonicalPath: fixture.file,
    principalId: OWNER,
    workSessionId: SESSION,
    stateRoot: fixture.stateRoot,
    nativeAdapter: { supported: () => true, validateAndRender: async () => { nativeCalls += 1; return { ok: true }; } },
    operations: [{ type: 'set_cell_value', sheet: 'Data', cell: 'A1', value: 2 }],
    acceptance: { nativeExcel: true, recalculate: true }
  }), /EXCEL_NATIVE_RECALC_BLOCKED/);
  assert.equal(nativeCalls, 0);
  assert.equal(sha256Bytes(await fs.readFile(fixture.file)), sha256Bytes(fixture.original));
});

test('Excel rollback is Work Session owned and refuses to overwrite newer edits', async t => {
  const fixture = await tempWorkbook(); t.after(async () => fs.rm(fixture.dir, { recursive: true, force: true }));
  const applied = await transactionalExcelEdit({ canonicalPath: fixture.file, principalId: OWNER, workSessionId: SESSION, stateRoot: fixture.stateRoot, operations: [{ type: 'set_cell_value', sheet: 'Data', cell: 'A1', value: 2 }], acceptance: { nativeExcel: false } });
  await assert.rejects(rollbackExcelTransaction({ canonicalPath: fixture.file, transactionId: applied.transaction.id, principalId: OWNER, workSessionId: '22222222-2222-4222-8222-222222222222', stateRoot: fixture.stateRoot }), /OFFICE_TRANSACTION_OWNER_MISMATCH/);
  const newer = Buffer.concat([await fs.readFile(fixture.file), Buffer.from([0])]); await fs.writeFile(fixture.file, newer); const newerSha = sha256Bytes(newer);
  await assert.rejects(rollbackExcelTransaction({ canonicalPath: fixture.file, transactionId: applied.transaction.id, principalId: OWNER, workSessionId: SESSION, stateRoot: fixture.stateRoot }), /OFFICE_ROLLBACK_CONFLICT/);
  assert.equal(sha256Bytes(await fs.readFile(fixture.file)), newerSha);
});
