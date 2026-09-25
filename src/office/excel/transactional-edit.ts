import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { editExcelXlsx, type ExcelEditOperation } from './editor.js';
import { inspectExcelWorkbook } from './inspector.js';
import { NativeExcelAdapter, type NativeExcelValidationResult } from '../backends/windows-com/excel-native.js';
import { appendOfficeEvidence, appendOfficeTransactionBackend, createOfficeTransaction, setOfficeValidation, transitionOfficeTransaction, verifyOfficeCommitRevision, type OfficeTransaction } from '../common/transaction.js';
import { createOfficeDocumentIdentity, normalizeCanonicalOfficePath, sameOfficeDocumentRevision } from '../common/document-identity.js';
import { officeValidationResult, requireOfficeValidationPass } from '../common/validation.js';
import { setupConfigDir } from '../../setup/settings.js';

export interface ExcelEditAcceptance {
  nativeExcel?: boolean;
  recalculate?: boolean;
  exportPdf?: boolean;
  preserveSheetNames?: string[];
  minFormulaCount?: number;
  maxFormulaErrors?: number;
}
export interface TransactionalExcelEditInput {
  canonicalPath: string; principalId: string; workSessionId: string; operations: ExcelEditOperation[];
  expectedSha256?: string; acceptance?: ExcelEditAcceptance; nativeAdapter?: Pick<NativeExcelAdapter, 'supported' | 'validateAndRender'>;
  maxWriteBytes?: number; stateRoot?: string;
}
interface StoredExcelTransaction { version: 1; transaction: OfficeTransaction; backupPath: string; documentPath: string; committedIdentity?: ReturnType<typeof createOfficeDocumentIdentity>; rollback?: { restoredAt: string; restoredIdentity: ReturnType<typeof createOfficeDocumentIdentity> }; }
const shaPattern = /^[0-9a-f]{64}$/;
const officeStateRoot = (override?: string) => path.resolve(override ?? path.join(setupConfigDir(), 'office', 'excel'));
const documentStateKey = (canonicalPath: string) => createHash('sha256').update(normalizeCanonicalOfficePath(canonicalPath)).digest('hex');
const documentStateRoot = (canonicalPath: string, stateRoot?: string) => path.join(officeStateRoot(stateRoot), documentStateKey(canonicalPath));
const transactionDirectory = (canonicalPath: string, transactionId: string, stateRoot?: string) => path.join(documentStateRoot(canonicalPath, stateRoot), transactionId);
const transactionRecordPath = (canonicalPath: string, transactionId: string, stateRoot?: string) => path.join(transactionDirectory(canonicalPath, transactionId, stateRoot), 'record.json');

async function ensureRealDirectory(directory: string, recursive = false): Promise<void> {
  try { const stat = await fs.lstat(directory); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`OFFICE_STATE_PATH_UNSAFE: '${directory}' must be a real directory.`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await fs.mkdir(directory, { recursive }); const stat = await fs.lstat(directory); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`OFFICE_STATE_PATH_UNSAFE: '${directory}' was not created as a real directory.`); }
}
async function assertRealDirectory(directory: string): Promise<void> { const stat = await fs.lstat(directory); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`OFFICE_STATE_PATH_UNSAFE: '${directory}' must be a real directory.`); }
async function persistTransaction(recordPath: string, record: StoredExcelTransaction): Promise<void> { await assertRealDirectory(path.dirname(recordPath)); const temp = `${recordPath}.${randomUUID()}.tmp`; await fs.writeFile(temp, JSON.stringify(record, null, 2), { encoding: 'utf8', flag: 'wx' }); await fs.rename(temp, recordPath); }
async function identityFromFile(canonicalPath: string) { const [bytes, stat] = await Promise.all([fs.readFile(canonicalPath), fs.stat(canonicalPath)]); return createOfficeDocumentIdentity({ canonicalPath, bytes, modifiedTimeMs: stat.mtimeMs }); }
async function writeSameVolumeReplacement(target: string, bytes: Uint8Array, suffix: string): Promise<void> {
  const stagingPath = path.join(path.dirname(target), `.${path.basename(target)}.${suffix}.${randomUUID()}.tmp`); const handle = await fs.open(stagingPath, 'wx');
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  try { await fs.rename(stagingPath, target); } finally { await fs.rm(stagingPath, { force: true }).catch(() => {}); }
}
async function prepareTransactionDirectory(canonicalPath: string, transactionId: string, stateRoot?: string): Promise<string> {
  const root = officeStateRoot(stateRoot); await ensureRealDirectory(root, true); const documentRoot = documentStateRoot(canonicalPath, stateRoot); await ensureRealDirectory(documentRoot); const txDir = transactionDirectory(canonicalPath, transactionId, stateRoot); await ensureRealDirectory(txDir); return txDir;
}
function assertSafeMutationWorkbook(inspection: ReturnType<typeof inspectExcelWorkbook>): void {
  if (inspection.security.macrosPresent) throw new Error('OFFICE_ACTIVE_CONTENT_BLOCKED: macros are not accepted by Excel mutation v1.');
  if (inspection.security.activeXPresent) throw new Error('OFFICE_ACTIVE_CONTENT_BLOCKED: ActiveX content is not accepted by Excel mutation v1.');
  if (inspection.security.embeddedObjectsPresent) throw new Error('OFFICE_ACTIVE_CONTENT_BLOCKED: embedded OLE objects are not accepted by Excel mutation v1.');
  if (inspection.security.externalLinksPresent) throw new Error('OFFICE_EXTERNAL_CONTENT_BLOCKED: external workbook links are not accepted by Excel mutation v1.');
}

export async function transactionalExcelEdit(input: TransactionalExcelEditInput) {
  if (!input.principalId.trim() || !input.workSessionId.trim()) throw new Error('Office mutation owner must be explicit.');
  if (input.expectedSha256 && !shaPattern.test(input.expectedSha256)) throw new Error('expectedSha256 must be 64 lowercase hex characters.');
  const canonicalPath = path.resolve(input.canonicalPath);
  if (path.extname(canonicalPath).toLowerCase() !== '.xlsx') throw new Error('excel_edit mutation v1 supports only .xlsx. Macro-enabled/template formats remain inspection-only.');
  const [originalBytes, originalStat] = await Promise.all([fs.readFile(canonicalPath), fs.stat(canonicalPath)]);
  const originalIdentity = createOfficeDocumentIdentity({ canonicalPath, bytes: originalBytes, modifiedTimeMs: originalStat.mtimeMs });
  if (input.expectedSha256 && input.expectedSha256 !== originalIdentity.sha256) throw new Error(`OFFICE_CONFLICT: expected SHA-256 ${input.expectedSha256}, current ${originalIdentity.sha256}.`);
  const originalInspection = inspectExcelWorkbook({ canonicalPath, bytes: originalBytes, modifiedTimeMs: originalStat.mtimeMs, maxCellsPerSheet: 50_000 }); assertSafeMutationWorkbook(originalInspection);
  let tx = createOfficeTransaction({ principalId: input.principalId, workSessionId: input.workSessionId, original: originalIdentity }); tx = appendOfficeTransactionBackend(tx, 'ooxml'); tx = transitionOfficeTransaction(tx, 'inspected');
  const txDir = await prepareTransactionDirectory(canonicalPath, tx.id, input.stateRoot); const backupPath = path.join(txDir, 'backup.xlsx'); const workingPath = path.join(txDir, 'working.xlsx'); const pdfPath = path.join(txDir, 'evidence.pdf'); const recordPath = path.join(txDir, 'record.json');
  await fs.writeFile(backupPath, originalBytes, { flag: 'wx' }); tx = { ...tx, backupPath }; tx = transitionOfficeTransaction(tx, 'snapshotted'); await fs.writeFile(workingPath, originalBytes, { flag: 'wx' }); tx = { ...tx, workingCopyPath: workingPath }; tx = transitionOfficeTransaction(tx, 'working'); await persistTransaction(recordPath, { version: 1, transaction: tx, backupPath, documentPath: canonicalPath });
  let committed = false; let targetReplaced = false; let native: NativeExcelValidationResult | undefined;
  try {
    const edited = editExcelXlsx(originalBytes, input.operations); if (input.maxWriteBytes !== undefined && edited.bytes.byteLength > input.maxWriteBytes) throw new Error(`Write exceeds maxWriteBytes (${input.maxWriteBytes}).`);
    await fs.writeFile(workingPath, edited.bytes, { flag: 'w' }); tx = transitionOfficeTransaction(tx, 'patched');
    const workingStat = await fs.stat(workingPath); const inspection = inspectExcelWorkbook({ canonicalPath: workingPath, bytes: edited.bytes, modifiedTimeMs: workingStat.mtimeMs, maxCellsPerSheet: 50_000 }); assertSafeMutationWorkbook(inspection);
    const acceptance = input.acceptance ?? {}; const names = new Set(inspection.sheets.map(sheet => sheet.name));
    const assertions = [
      { id: 'package_opens', passed: true, expected: true, actual: true },
      { id: 'required_sheets_preserved', passed: (acceptance.preserveSheetNames ?? []).every(name => names.has(name)), expected: (acceptance.preserveSheetNames ?? []).length, actual: (acceptance.preserveSheetNames ?? []).filter(name => names.has(name)).length },
      { id: 'formula_count', passed: inspection.totals.formulas >= (acceptance.minFormulaCount ?? 0), expected: acceptance.minFormulaCount ?? 0, actual: inspection.totals.formulas }
    ];
    if (acceptance.nativeExcel) {
      const adapter = input.nativeAdapter ?? new NativeExcelAdapter(); if (!adapter.supported()) throw new Error('EXCEL_COM_UNAVAILABLE: native Excel acceptance was required but this node is not Windows.');
      tx = appendOfficeTransactionBackend(tx, 'windows-com'); native = await adapter.validateAndRender(workingPath, pdfPath, { recalculate: acceptance.recalculate ?? true, exportPdf: acceptance.exportPdf ?? false });
      tx = transitionOfficeTransaction(tx, 'app-opened'); tx = appendOfficeEvidence(tx, { kind: 'application-open', createdAt: new Date().toISOString(), backend: 'windows-com' }); assertions.push({ id: 'workbook_opens', passed: native.ok, expected: true, actual: native.ok });
      if (acceptance.maxFormulaErrors !== undefined) assertions.push({ id: 'formula_errors', passed: (native.formulaErrors ?? Number.MAX_SAFE_INTEGER) <= acceptance.maxFormulaErrors, expected: acceptance.maxFormulaErrors, actual: native.formulaErrors ?? Number.MAX_SAFE_INTEGER });
      if (acceptance.exportPdf ?? false) { tx = transitionOfficeTransaction(tx, 'rendered'); const pdfStat = await fs.stat(pdfPath); tx = appendOfficeEvidence(tx, { kind: 'pdf', path: pdfPath, createdAt: new Date().toISOString(), backend: 'windows-com' }); assertions.push({ id: 'pdf_render_nonempty', passed: pdfStat.size > 0, expected: true, actual: pdfStat.size > 0 }); }
    }
    const validation = officeValidationResult(assertions); tx = transitionOfficeTransaction(tx, 'validated'); tx = setOfficeValidation(tx, validation); requireOfficeValidationPass(validation); tx = transitionOfficeTransaction(tx, 'accepted');
    const currentIdentity = await identityFromFile(canonicalPath); tx = verifyOfficeCommitRevision(tx, currentIdentity); if (tx.state === 'conflict') { await persistTransaction(recordPath, { version: 1, transaction: tx, backupPath, documentPath: canonicalPath }); throw new Error('OFFICE_CONFLICT: original workbook changed after inspection; commit refused.'); }
    await writeSameVolumeReplacement(canonicalPath, edited.bytes, `commit-${tx.id}`); targetReplaced = true; const committedIdentity = await identityFromFile(canonicalPath); const committedTx = transitionOfficeTransaction(tx, 'committed'); await persistTransaction(recordPath, { version: 1, transaction: committedTx, backupPath, documentPath: canonicalPath, committedIdentity }); tx = committedTx; committed = true;
    return { transaction: tx, backupPath, committedIdentity, applied: edited.applied, requiresRecalculation: edited.requiresRecalculation, ...(native ? { native } : {}), structural: { sheets: inspection.totals.sheets, cells: inspection.totals.cells, formulas: inspection.totals.formulas, tables: inspection.totals.tables } };
  } catch (error) {
    if (targetReplaced && !committed) { const backupBytes = await fs.readFile(backupPath); await writeSameVolumeReplacement(canonicalPath, backupBytes, `recovery-${tx.id}`); }
    if (!committed && tx.state !== 'conflict' && tx.state !== 'failed' && tx.state !== 'rolled-back') { try { tx = transitionOfficeTransaction(tx, 'rollback-pending'); tx = transitionOfficeTransaction(tx, 'rolled-back'); } catch {} }
    await persistTransaction(recordPath, { version: 1, transaction: tx, backupPath, documentPath: canonicalPath }).catch(() => {}); throw error;
  }
}

export async function rollbackExcelTransaction(input: { canonicalPath: string; transactionId: string; principalId: string; workSessionId: string; stateRoot?: string }) {
  if (!/^[0-9a-f-]{36}$/i.test(input.transactionId)) throw new Error('Invalid Office transaction id.');
  if (!input.principalId.trim() || !input.workSessionId.trim()) throw new Error('Office rollback owner must be explicit.');
  const canonicalPath = path.resolve(input.canonicalPath); const txDir = transactionDirectory(canonicalPath, input.transactionId, input.stateRoot); await assertRealDirectory(officeStateRoot(input.stateRoot)); await assertRealDirectory(documentStateRoot(canonicalPath, input.stateRoot)); await assertRealDirectory(txDir);
  const recordPath = transactionRecordPath(canonicalPath, input.transactionId, input.stateRoot); const raw = JSON.parse(await fs.readFile(recordPath, 'utf8')) as StoredExcelTransaction;
  if (raw.version !== 1 || raw.transaction.id !== input.transactionId || path.resolve(raw.documentPath) !== canonicalPath) throw new Error('OFFICE_TRANSACTION_INVALID: transaction record mismatch.');
  if (raw.transaction.principalId !== input.principalId || raw.transaction.workSessionId !== input.workSessionId) throw new Error('OFFICE_TRANSACTION_OWNER_MISMATCH: rollback is restricted to the principal and Work Session that created the transaction.');
  if (raw.transaction.state !== 'committed' || !raw.committedIdentity) throw new Error('OFFICE_TRANSACTION_NOT_ROLLBACKABLE: only a successfully committed Excel transaction can be rolled back.');
  const expectedBackupPath = path.join(txDir, 'backup.xlsx'); if (path.resolve(raw.backupPath) !== path.resolve(expectedBackupPath)) throw new Error('OFFICE_TRANSACTION_INVALID: backup path escaped the transaction state directory.');
  const currentIdentity = await identityFromFile(canonicalPath);
  if (sameOfficeDocumentRevision(currentIdentity, raw.transaction.original)) { if (!raw.rollback) { raw.rollback = { restoredAt: new Date().toISOString(), restoredIdentity: currentIdentity }; await persistTransaction(recordPath, raw); } return { transactionId: input.transactionId, restoredIdentity: currentIdentity, backupPath: raw.backupPath, alreadyRestored: true }; }
  if (!sameOfficeDocumentRevision(currentIdentity, raw.committedIdentity)) throw new Error('OFFICE_ROLLBACK_CONFLICT: workbook changed after this transaction committed; rollback refused to protect newer edits.');
  const backupStat = await fs.lstat(raw.backupPath); if (backupStat.isSymbolicLink() || !backupStat.isFile()) throw new Error('OFFICE_ROLLBACK_BACKUP_UNSAFE: recorded backup is missing, not a regular file, or is a symlink.');
  const backupBytes = await fs.readFile(raw.backupPath); const backupIdentity = createOfficeDocumentIdentity({ canonicalPath, bytes: backupBytes }); if (!sameOfficeDocumentRevision(backupIdentity, raw.transaction.original)) throw new Error('OFFICE_ROLLBACK_BACKUP_MISMATCH: recorded backup no longer matches the original SHA-256.');
  await writeSameVolumeReplacement(canonicalPath, backupBytes, `rollback-${input.transactionId}`); const restoredIdentity = await identityFromFile(canonicalPath); if (!sameOfficeDocumentRevision(restoredIdentity, raw.transaction.original)) throw new Error('OFFICE_ROLLBACK_VERIFY_FAILED: restored file does not match the recorded original SHA-256.');
  raw.rollback = { restoredAt: new Date().toISOString(), restoredIdentity }; await persistTransaction(recordPath, raw); return { transactionId: input.transactionId, restoredIdentity, backupPath: raw.backupPath, alreadyRestored: false };
}
