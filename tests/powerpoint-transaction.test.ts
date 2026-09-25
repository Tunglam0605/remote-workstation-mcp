import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { sha256Bytes } from '../src/office/common/document-identity.js';
import { inspectPowerPointPresentation } from '../src/office/powerpoint/inspector.js';
import { rollbackPowerPointTransaction, transactionalPowerPointEdit } from '../src/office/powerpoint/transactional-edit.js';
import { pptx } from './powerpoint-inspector.test.js';

const OWNER = 'test-principal';
const SESSION = '33333333-3333-4333-8333-333333333333';
async function tempPresentation(extra: Record<string, Uint8Array> = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-powerpoint-tx-'));
  const file = path.join(dir, 'deck.pptx'); const stateRoot = path.join(dir, 'state'); const original = pptx(extra); await fs.writeFile(file, original); return { dir, file, stateRoot, original };
}

test('transactional PowerPoint edit commits after structural/native acceptance and rollback restores exact original', async t => {
  const fixture = await tempPresentation(); t.after(async () => fs.rm(fixture.dir, { recursive: true, force: true })); let nativeCalls = 0;
  const nativeAdapter = {
    supported: () => true,
    validateAndRender: async (presentationPath: string, pdfPath: string) => {
      nativeCalls += 1; const inspection = inspectPowerPointPresentation({ canonicalPath: presentationPath, bytes: await fs.readFile(presentationPath) });
      assert.equal(inspection.slides[0]?.title, 'Updated title'); await fs.writeFile(pdfPath, Buffer.from('%PDF-1.7\npowerpoint\n'));
      return { ok: true, powerPointVersion: 'test', slides: inspection.totals.slides, shapes: inspection.totals.shapes, pdfPath };
    }
  };
  const originalSha = sha256Bytes(fixture.original);
  const applied = await transactionalPowerPointEdit({
    canonicalPath: fixture.file, principalId: OWNER, workSessionId: SESSION, stateRoot: fixture.stateRoot, expectedSha256: originalSha, maxWriteBytes: 10_000_000,
    nativeAdapter, operations: [{ type: 'set_slide_title', slideIndex: 1, text: 'Updated title' }, { type: 'set_shape_text', slideIndex: 1, shapeId: 3, text: 'Updated body' }],
    acceptance: { nativePowerPoint: true, exportPdf: true, minSlideCount: 2, minShapeCount: 3 }
  });
  assert.equal(applied.transaction.state, 'committed'); assert.equal(applied.transaction.validation?.passed, true); assert.equal(nativeCalls, 1); assert.notEqual(applied.committedIdentity.sha256, originalSha); assert.equal(sha256Bytes(await fs.readFile(applied.backupPath)), originalSha);
  const after = inspectPowerPointPresentation({ canonicalPath: fixture.file, bytes: await fs.readFile(fixture.file) });
  assert.equal(after.slides[0]?.title, 'Updated title'); assert.equal(after.totals.images, 1); assert.equal(after.totals.tables, 1); assert.equal(after.totals.charts, 1);
  const rollback = await rollbackPowerPointTransaction({ canonicalPath: fixture.file, transactionId: applied.transaction.id, principalId: OWNER, workSessionId: SESSION, stateRoot: fixture.stateRoot });
  assert.equal(rollback.alreadyRestored, false); assert.equal(rollback.restoredIdentity.sha256, originalSha);
  const second = await rollbackPowerPointTransaction({ canonicalPath: fixture.file, transactionId: applied.transaction.id, principalId: OWNER, workSessionId: SESSION, stateRoot: fixture.stateRoot }); assert.equal(second.alreadyRestored, true);
});

test('failed native PowerPoint acceptance leaves original byte-identical', async t => {
  const fixture = await tempPresentation(); t.after(async () => fs.rm(fixture.dir, { recursive: true, force: true })); const originalSha = sha256Bytes(fixture.original);
  await assert.rejects(transactionalPowerPointEdit({
    canonicalPath: fixture.file, principalId: OWNER, workSessionId: SESSION, stateRoot: fixture.stateRoot,
    nativeAdapter: { supported: () => true, validateAndRender: async () => ({ ok: true, slides: 1, shapes: 1 }) },
    operations: [{ type: 'set_slide_title', slideIndex: 1, text: 'Changed' }], acceptance: { nativePowerPoint: true }
  }), /OFFICE_ACCEPTANCE_FAILED/);
  assert.equal(sha256Bytes(await fs.readFile(fixture.file)), originalSha);
});

test('PowerPoint transaction rejects stale SHA and unsafe active/external content before mutation state', async t => {
  const fixture = await tempPresentation(); t.after(async () => fs.rm(fixture.dir, { recursive: true, force: true }));
  await assert.rejects(transactionalPowerPointEdit({ canonicalPath: fixture.file, principalId: OWNER, workSessionId: SESSION, stateRoot: fixture.stateRoot, expectedSha256: '0'.repeat(64), operations: [{ type: 'set_slide_title', slideIndex: 1, text: 'x' }], acceptance: { nativePowerPoint: false } }), /OFFICE_CONFLICT/);
  await assert.rejects(fs.stat(fixture.stateRoot), /ENOENT/);
  const unsafe = await tempPresentation({ 'ppt/vbaProject.bin': Uint8Array.from([1]) }); t.after(async () => fs.rm(unsafe.dir, { recursive: true, force: true }));
  await assert.rejects(transactionalPowerPointEdit({ canonicalPath: unsafe.file, principalId: OWNER, workSessionId: SESSION, stateRoot: unsafe.stateRoot, operations: [{ type: 'set_slide_title', slideIndex: 1, text: 'x' }], acceptance: { nativePowerPoint: false } }), /OFFICE_ACTIVE_CONTENT_BLOCKED/);
  await assert.rejects(fs.stat(unsafe.stateRoot), /ENOENT/);
});

test('PowerPoint rollback is Work Session owned and refuses to overwrite newer edits', async t => {
  const fixture = await tempPresentation(); t.after(async () => fs.rm(fixture.dir, { recursive: true, force: true }));
  const applied = await transactionalPowerPointEdit({ canonicalPath: fixture.file, principalId: OWNER, workSessionId: SESSION, stateRoot: fixture.stateRoot, operations: [{ type: 'set_slide_title', slideIndex: 1, text: 'Committed' }], acceptance: { nativePowerPoint: false } });
  await assert.rejects(rollbackPowerPointTransaction({ canonicalPath: fixture.file, transactionId: applied.transaction.id, principalId: OWNER, workSessionId: '44444444-4444-4444-8444-444444444444', stateRoot: fixture.stateRoot }), /OFFICE_TRANSACTION_OWNER_MISMATCH/);
  const newer = Buffer.concat([await fs.readFile(fixture.file), Buffer.from([0])]); await fs.writeFile(fixture.file, newer); const newerSha = sha256Bytes(newer);
  await assert.rejects(rollbackPowerPointTransaction({ canonicalPath: fixture.file, transactionId: applied.transaction.id, principalId: OWNER, workSessionId: SESSION, stateRoot: fixture.stateRoot }), /OFFICE_ROLLBACK_CONFLICT/);
  assert.equal(sha256Bytes(await fs.readFile(fixture.file)), newerSha);
});
