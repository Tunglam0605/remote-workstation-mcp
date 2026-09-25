import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { editPowerPointPptx, type PowerPointEditOperation } from './editor.js';
import { inspectPowerPointPresentation } from './inspector.js';
import { NativePowerPointAdapter, type NativePowerPointValidationResult } from '../backends/windows-com/powerpoint-native.js';
import { appendOfficeEvidence, appendOfficeTransactionBackend, createOfficeTransaction, setOfficeValidation, transitionOfficeTransaction, verifyOfficeCommitRevision, type OfficeTransaction } from '../common/transaction.js';
import { createOfficeDocumentIdentity, normalizeCanonicalOfficePath, sameOfficeDocumentRevision } from '../common/document-identity.js';
import { officeValidationResult, requireOfficeValidationPass } from '../common/validation.js';
import { setupConfigDir } from '../../setup/settings.js';

export interface PowerPointEditAcceptance {
  nativePowerPoint?: boolean;
  exportPdf?: boolean;
  minSlideCount?: number;
  minShapeCount?: number;
}
export interface TransactionalPowerPointEditInput {
  canonicalPath: string; principalId: string; workSessionId: string; operations: PowerPointEditOperation[];
  expectedSha256?: string; acceptance?: PowerPointEditAcceptance; nativeAdapter?: Pick<NativePowerPointAdapter, 'supported' | 'validateAndRender'>;
  maxWriteBytes?: number; stateRoot?: string;
}
interface StoredPowerPointTransaction { version: 1; transaction: OfficeTransaction; backupPath: string; documentPath: string; committedIdentity?: ReturnType<typeof createOfficeDocumentIdentity>; rollback?: { restoredAt: string; restoredIdentity: ReturnType<typeof createOfficeDocumentIdentity> }; }
const shaPattern = /^[0-9a-f]{64}$/;
const officeStateRoot = (override?: string) => path.resolve(override ?? path.join(setupConfigDir(), 'office', 'powerpoint'));
const documentStateKey = (canonicalPath: string) => createHash('sha256').update(normalizeCanonicalOfficePath(canonicalPath)).digest('hex');
const documentStateRoot = (canonicalPath: string, stateRoot?: string) => path.join(officeStateRoot(stateRoot), documentStateKey(canonicalPath));
const transactionDirectory = (canonicalPath: string, transactionId: string, stateRoot?: string) => path.join(documentStateRoot(canonicalPath, stateRoot), transactionId);
const transactionRecordPath = (canonicalPath: string, transactionId: string, stateRoot?: string) => path.join(transactionDirectory(canonicalPath, transactionId, stateRoot), 'record.json');
async function ensureRealDirectory(directory: string, recursive = false): Promise<void> { try { const stat = await fs.lstat(directory); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`OFFICE_STATE_PATH_UNSAFE: '${directory}' must be a real directory.`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await fs.mkdir(directory, { recursive }); const stat = await fs.lstat(directory); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`OFFICE_STATE_PATH_UNSAFE: '${directory}' was not created as a real directory.`); } }
async function assertRealDirectory(directory: string): Promise<void> { const stat = await fs.lstat(directory); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`OFFICE_STATE_PATH_UNSAFE: '${directory}' must be a real directory.`); }
async function persistTransaction(recordPath: string, record: StoredPowerPointTransaction): Promise<void> { await assertRealDirectory(path.dirname(recordPath)); const temp = `${recordPath}.${randomUUID()}.tmp`; await fs.writeFile(temp, JSON.stringify(record, null, 2), { encoding: 'utf8', flag: 'wx' }); await fs.rename(temp, recordPath); }
async function identityFromFile(canonicalPath: string) { const [bytes, stat] = await Promise.all([fs.readFile(canonicalPath), fs.stat(canonicalPath)]); return createOfficeDocumentIdentity({ canonicalPath, bytes, modifiedTimeMs: stat.mtimeMs }); }
async function writeSameVolumeReplacement(target: string, bytes: Uint8Array, suffix: string): Promise<void> { const stagingPath = path.join(path.dirname(target), `.${path.basename(target)}.${suffix}.${randomUUID()}.tmp`); const handle = await fs.open(stagingPath, 'wx'); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); } try { await fs.rename(stagingPath, target); } finally { await fs.rm(stagingPath, { force: true }).catch(() => {}); } }
async function prepareTransactionDirectory(canonicalPath: string, transactionId: string, stateRoot?: string): Promise<string> { const root = officeStateRoot(stateRoot); await ensureRealDirectory(root, true); const documentRoot = documentStateRoot(canonicalPath, stateRoot); await ensureRealDirectory(documentRoot); const txDir = transactionDirectory(canonicalPath, transactionId, stateRoot); await ensureRealDirectory(txDir); return txDir; }
function assertSafeMutationPresentation(inspection: ReturnType<typeof inspectPowerPointPresentation>): void {
  if (inspection.security.macrosPresent) throw new Error('OFFICE_ACTIVE_CONTENT_BLOCKED: macros are not accepted by PowerPoint mutation v1.');
  if (inspection.security.activeXPresent) throw new Error('OFFICE_ACTIVE_CONTENT_BLOCKED: ActiveX content is not accepted by PowerPoint mutation v1.');
  if (inspection.security.embeddedObjectsPresent) throw new Error('OFFICE_ACTIVE_CONTENT_BLOCKED: embedded OLE objects are not accepted by PowerPoint mutation v1.');
  if (inspection.security.externalRelationships.length > 0) throw new Error('OFFICE_EXTERNAL_CONTENT_BLOCKED: external relationships are not accepted by PowerPoint mutation v1.');
}

export async function transactionalPowerPointEdit(input: TransactionalPowerPointEditInput) {
  if (!input.principalId.trim() || !input.workSessionId.trim()) throw new Error('Office mutation owner must be explicit.');
  if (input.expectedSha256 && !shaPattern.test(input.expectedSha256)) throw new Error('expectedSha256 must be 64 lowercase hex characters.');
  const canonicalPath = path.resolve(input.canonicalPath);
  if (path.extname(canonicalPath).toLowerCase() !== '.pptx') throw new Error('powerpoint_edit mutation v1 supports only .pptx. Macro-enabled/template/show formats remain inspection-only.');
  const [originalBytes, originalStat] = await Promise.all([fs.readFile(canonicalPath), fs.stat(canonicalPath)]);
  const originalIdentity = createOfficeDocumentIdentity({ canonicalPath, bytes: originalBytes, modifiedTimeMs: originalStat.mtimeMs });
  if (input.expectedSha256 && input.expectedSha256 !== originalIdentity.sha256) throw new Error(`OFFICE_CONFLICT: expected SHA-256 ${input.expectedSha256}, current ${originalIdentity.sha256}.`);
  const originalInspection = inspectPowerPointPresentation({ canonicalPath, bytes: originalBytes, modifiedTimeMs: originalStat.mtimeMs, maxShapesPerSlide: 5000 }); assertSafeMutationPresentation(originalInspection);
  let tx = createOfficeTransaction({ principalId: input.principalId, workSessionId: input.workSessionId, original: originalIdentity }); tx = appendOfficeTransactionBackend(tx, 'ooxml'); tx = transitionOfficeTransaction(tx, 'inspected');
  const txDir = await prepareTransactionDirectory(canonicalPath, tx.id, input.stateRoot); const backupPath = path.join(txDir, 'backup.pptx'); const workingPath = path.join(txDir, 'working.pptx'); const pdfPath = path.join(txDir, 'evidence.pdf'); const recordPath = path.join(txDir, 'record.json');
  await fs.writeFile(backupPath, originalBytes, { flag: 'wx' }); tx = { ...tx, backupPath }; tx = transitionOfficeTransaction(tx, 'snapshotted'); await fs.writeFile(workingPath, originalBytes, { flag: 'wx' }); tx = { ...tx, workingCopyPath: workingPath }; tx = transitionOfficeTransaction(tx, 'working'); await persistTransaction(recordPath, { version: 1, transaction: tx, backupPath, documentPath: canonicalPath });
  let committed = false; let targetReplaced = false; let native: NativePowerPointValidationResult | undefined;
  try {
    const edited = editPowerPointPptx(originalBytes, input.operations); if (input.maxWriteBytes !== undefined && edited.bytes.byteLength > input.maxWriteBytes) throw new Error(`Write exceeds maxWriteBytes (${input.maxWriteBytes}).`);
    await fs.writeFile(workingPath, edited.bytes, { flag: 'w' }); tx = transitionOfficeTransaction(tx, 'patched');
    const workingStat = await fs.stat(workingPath); const inspection = inspectPowerPointPresentation({ canonicalPath: workingPath, bytes: edited.bytes, modifiedTimeMs: workingStat.mtimeMs, maxShapesPerSlide: 5000 }); assertSafeMutationPresentation(inspection);
    const acceptance = input.acceptance ?? {};
    const assertions = [
      { id: 'package_opens', passed: true, expected: true, actual: true },
      { id: 'slide_count_unchanged', passed: inspection.totals.slides === originalInspection.totals.slides, expected: originalInspection.totals.slides, actual: inspection.totals.slides },
      { id: 'shape_count_unchanged', passed: inspection.totals.shapes === originalInspection.totals.shapes, expected: originalInspection.totals.shapes, actual: inspection.totals.shapes },
      { id: 'image_count_unchanged', passed: inspection.totals.images === originalInspection.totals.images, expected: originalInspection.totals.images, actual: inspection.totals.images },
      { id: 'table_count_unchanged', passed: inspection.totals.tables === originalInspection.totals.tables, expected: originalInspection.totals.tables, actual: inspection.totals.tables },
      { id: 'chart_count_unchanged', passed: inspection.totals.charts === originalInspection.totals.charts, expected: originalInspection.totals.charts, actual: inspection.totals.charts },
      { id: 'min_slide_count', passed: inspection.totals.slides >= (acceptance.minSlideCount ?? 0), expected: acceptance.minSlideCount ?? 0, actual: inspection.totals.slides },
      { id: 'min_shape_count', passed: inspection.totals.shapes >= (acceptance.minShapeCount ?? 0), expected: acceptance.minShapeCount ?? 0, actual: inspection.totals.shapes }
    ];
    if (acceptance.nativePowerPoint) {
      const adapter = input.nativeAdapter ?? new NativePowerPointAdapter(); if (!adapter.supported()) throw new Error('POWERPOINT_COM_UNAVAILABLE: native PowerPoint acceptance was required but this node is not Windows.');
      tx = appendOfficeTransactionBackend(tx, 'windows-com'); native = await adapter.validateAndRender(workingPath, pdfPath, { exportPdf: acceptance.exportPdf ?? false });
      tx = transitionOfficeTransaction(tx, 'app-opened'); tx = appendOfficeEvidence(tx, { kind: 'application-open', createdAt: new Date().toISOString(), backend: 'windows-com' });
      assertions.push({ id: 'presentation_opens', passed: native.ok, expected: true, actual: native.ok });
      assertions.push({ id: 'native_slide_count', passed: (native.slides ?? -1) === inspection.totals.slides, expected: inspection.totals.slides, actual: native.slides ?? -1 });
      if (acceptance.exportPdf ?? false) { tx = transitionOfficeTransaction(tx, 'rendered'); const pdfStat = await fs.stat(pdfPath); tx = appendOfficeEvidence(tx, { kind: 'pdf', path: pdfPath, createdAt: new Date().toISOString(), backend: 'windows-com' }); assertions.push({ id: 'pdf_render_nonempty', passed: pdfStat.size > 0, expected: true, actual: pdfStat.size > 0 }); }
    }
    const validation = officeValidationResult(assertions); tx = transitionOfficeTransaction(tx, 'validated'); tx = setOfficeValidation(tx, validation); requireOfficeValidationPass(validation); tx = transitionOfficeTransaction(tx, 'accepted');
    const currentIdentity = await identityFromFile(canonicalPath); tx = verifyOfficeCommitRevision(tx, currentIdentity); if (tx.state === 'conflict') { await persistTransaction(recordPath, { version: 1, transaction: tx, backupPath, documentPath: canonicalPath }); throw new Error('OFFICE_CONFLICT: original presentation changed after inspection; commit refused.'); }
    await writeSameVolumeReplacement(canonicalPath, edited.bytes, `commit-${tx.id}`); targetReplaced = true; const committedIdentity = await identityFromFile(canonicalPath); const committedTx = transitionOfficeTransaction(tx, 'committed'); await persistTransaction(recordPath, { version: 1, transaction: committedTx, backupPath, documentPath: canonicalPath, committedIdentity }); tx = committedTx; committed = true;
    return { transaction: tx, backupPath, committedIdentity, applied: edited.applied, ...(native ? { native } : {}), structural: inspection.totals };
  } catch (error) {
    if (targetReplaced && !committed) { const backupBytes = await fs.readFile(backupPath); await writeSameVolumeReplacement(canonicalPath, backupBytes, `recovery-${tx.id}`); }
    if (!committed && tx.state !== 'conflict' && tx.state !== 'failed' && tx.state !== 'rolled-back') { try { tx = transitionOfficeTransaction(tx, 'rollback-pending'); tx = transitionOfficeTransaction(tx, 'rolled-back'); } catch {} }
    await persistTransaction(recordPath, { version: 1, transaction: tx, backupPath, documentPath: canonicalPath }).catch(() => {}); throw error;
  }
}

export async function rollbackPowerPointTransaction(input: { canonicalPath: string; transactionId: string; principalId: string; workSessionId: string; stateRoot?: string }) {
  if (!/^[0-9a-f-]{36}$/i.test(input.transactionId)) throw new Error('Invalid Office transaction id.');
  if (!input.principalId.trim() || !input.workSessionId.trim()) throw new Error('Office rollback owner must be explicit.');
  const canonicalPath = path.resolve(input.canonicalPath); const txDir = transactionDirectory(canonicalPath, input.transactionId, input.stateRoot); await assertRealDirectory(officeStateRoot(input.stateRoot)); await assertRealDirectory(documentStateRoot(canonicalPath, input.stateRoot)); await assertRealDirectory(txDir);
  const recordPath = transactionRecordPath(canonicalPath, input.transactionId, input.stateRoot); const raw = JSON.parse(await fs.readFile(recordPath, 'utf8')) as StoredPowerPointTransaction;
  if (raw.version !== 1 || raw.transaction.id !== input.transactionId || path.resolve(raw.documentPath) !== canonicalPath) throw new Error('OFFICE_TRANSACTION_INVALID: transaction record mismatch.');
  if (raw.transaction.principalId !== input.principalId || raw.transaction.workSessionId !== input.workSessionId) throw new Error('OFFICE_TRANSACTION_OWNER_MISMATCH: rollback is restricted to the principal and Work Session that created the transaction.');
  if (raw.transaction.state !== 'committed' || !raw.committedIdentity) throw new Error('OFFICE_TRANSACTION_NOT_ROLLBACKABLE: only a successfully committed PowerPoint transaction can be rolled back.');
  const expectedBackupPath = path.join(txDir, 'backup.pptx'); if (path.resolve(raw.backupPath) !== path.resolve(expectedBackupPath)) throw new Error('OFFICE_TRANSACTION_INVALID: backup path escaped the transaction state directory.');
  const currentIdentity = await identityFromFile(canonicalPath);
  if (sameOfficeDocumentRevision(currentIdentity, raw.transaction.original)) { if (!raw.rollback) { raw.rollback = { restoredAt: new Date().toISOString(), restoredIdentity: currentIdentity }; await persistTransaction(recordPath, raw); } return { transactionId: input.transactionId, restoredIdentity: currentIdentity, backupPath: raw.backupPath, alreadyRestored: true }; }
  if (!sameOfficeDocumentRevision(currentIdentity, raw.committedIdentity)) throw new Error('OFFICE_ROLLBACK_CONFLICT: presentation changed after this transaction committed; rollback refused to protect newer edits.');
  const backupStat = await fs.lstat(raw.backupPath); if (backupStat.isSymbolicLink() || !backupStat.isFile()) throw new Error('OFFICE_ROLLBACK_BACKUP_UNSAFE: recorded backup is missing, not a regular file, or is a symlink.');
  const backupBytes = await fs.readFile(raw.backupPath); const backupIdentity = createOfficeDocumentIdentity({ canonicalPath, bytes: backupBytes }); if (!sameOfficeDocumentRevision(backupIdentity, raw.transaction.original)) throw new Error('OFFICE_ROLLBACK_BACKUP_MISMATCH: recorded backup no longer matches the original SHA-256.');
  await writeSameVolumeReplacement(canonicalPath, backupBytes, `rollback-${input.transactionId}`); const restoredIdentity = await identityFromFile(canonicalPath); if (!sameOfficeDocumentRevision(restoredIdentity, raw.transaction.original)) throw new Error('OFFICE_ROLLBACK_VERIFY_FAILED: restored file does not match the recorded original SHA-256.');
  raw.rollback = { restoredAt: new Date().toISOString(), restoredIdentity }; await persistTransaction(recordPath, raw); return { transactionId: input.transactionId, restoredIdentity, backupPath: raw.backupPath, alreadyRestored: false };
}
