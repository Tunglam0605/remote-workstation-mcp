import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { WordEditOperation } from './editor.js';
import { editWordDocx } from './editor.js';
import { inspectWordDocx } from './inspector.js';
import { NativeWordAdapter, type NativeWordValidationResult } from '../backends/windows-com/word-native.js';
import {
  appendOfficeEvidence,
  appendOfficeTransactionBackend,
  createOfficeTransaction,
  setOfficeValidation,
  transitionOfficeTransaction,
  verifyOfficeCommitRevision,
  type OfficeTransaction
} from '../common/transaction.js';
import {
  createOfficeDocumentIdentity,
  normalizeCanonicalOfficePath,
  sameOfficeDocumentRevision
} from '../common/document-identity.js';
import { officeValidationResult, requireOfficeValidationPass } from '../common/validation.js';
import { setupConfigDir } from '../../setup/settings.js';

export interface WordEditAcceptance {
  nativeWord?: boolean;
  exportPdf?: boolean;
  minEquationCount?: number;
  removedImageRelationshipIds?: string[];
  preserveHeadingTexts?: string[];
}

export interface TransactionalWordEditInput {
  canonicalPath: string;
  principalId: string;
  workSessionId: string;
  operations: WordEditOperation[];
  expectedSha256?: string;
  acceptance?: WordEditAcceptance;
  nativeAdapter?: Pick<NativeWordAdapter, 'supported' | 'validateAndRender'>;
  maxWriteBytes?: number;
  stateRoot?: string;
}

export interface TransactionalWordEditResult {
  transaction: OfficeTransaction;
  backupPath: string;
  committedIdentity: ReturnType<typeof createOfficeDocumentIdentity>;
  applied: Array<{ index: number; type: WordEditOperation['type']; target: string }>;
  native?: NativeWordValidationResult;
  structural: {
    paragraphs: number;
    headings: number;
    tables: number;
    images: number;
    equations: number;
    sections: number;
  };
}

interface StoredWordTransaction {
  version: 1;
  transaction: OfficeTransaction;
  backupPath: string;
  documentPath: string;
  committedIdentity?: ReturnType<typeof createOfficeDocumentIdentity>;
  rollback?: { restoredAt: string; restoredIdentity: ReturnType<typeof createOfficeDocumentIdentity> };
}

const shaPattern = /^[0-9a-f]{64}$/;

function officeStateRoot(override?: string): string {
  return path.resolve(override ?? path.join(setupConfigDir(), 'office', 'word'));
}

function documentStateKey(canonicalPath: string): string {
  return createHash('sha256').update(normalizeCanonicalOfficePath(canonicalPath)).digest('hex');
}

function documentStateRoot(canonicalPath: string, stateRoot?: string): string {
  return path.join(officeStateRoot(stateRoot), documentStateKey(canonicalPath));
}

function transactionDirectory(canonicalPath: string, transactionId: string, stateRoot?: string): string {
  return path.join(documentStateRoot(canonicalPath, stateRoot), transactionId);
}

function transactionRecordPath(canonicalPath: string, transactionId: string, stateRoot?: string): string {
  return path.join(transactionDirectory(canonicalPath, transactionId, stateRoot), 'record.json');
}

async function ensureRealDirectory(directory: string, recursive = false): Promise<void> {
  try {
    const stat = await fs.lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`OFFICE_STATE_PATH_UNSAFE: '${directory}' must be a real directory.`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await fs.mkdir(directory, { recursive });
    const stat = await fs.lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`OFFICE_STATE_PATH_UNSAFE: '${directory}' was not created as a real directory.`);
    }
  }
}

async function assertRealDirectory(directory: string): Promise<void> {
  const stat = await fs.lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`OFFICE_STATE_PATH_UNSAFE: '${directory}' must be a real directory.`);
  }
}

async function persistTransaction(recordPath: string, record: StoredWordTransaction): Promise<void> {
  await assertRealDirectory(path.dirname(recordPath));
  const temp = `${recordPath}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(record, null, 2), { encoding: 'utf8', flag: 'wx' });
  await fs.rename(temp, recordPath);
}

function assertSafeMutationDocument(inspection: ReturnType<typeof inspectWordDocx>): void {
  if (inspection.security.macrosPresent) throw new Error('OFFICE_ACTIVE_CONTENT_BLOCKED: macros are not accepted by Word mutation v1.');
  if (inspection.security.activeXPresent) throw new Error('OFFICE_ACTIVE_CONTENT_BLOCKED: ActiveX content is not accepted by Word mutation v1.');
  if (inspection.security.remoteTemplatePresent) throw new Error('OFFICE_ACTIVE_CONTENT_BLOCKED: remote templates are not accepted by Word mutation v1.');
  if (inspection.security.embeddedObjectsPresent) throw new Error('OFFICE_ACTIVE_CONTENT_BLOCKED: embedded OLE objects are not accepted by Word mutation v1.');
}

function headingTexts(inspection: ReturnType<typeof inspectWordDocx>): Set<string> {
  return new Set(inspection.headings.map(item => item.text));
}

function imageRelationshipIds(inspection: ReturnType<typeof inspectWordDocx>): Set<string> {
  return new Set(inspection.images.map(item => item.relationshipId).filter((id): id is string => Boolean(id)));
}

async function identityFromFile(canonicalPath: string) {
  const [bytes, stat] = await Promise.all([fs.readFile(canonicalPath), fs.stat(canonicalPath)]);
  return createOfficeDocumentIdentity({ canonicalPath, bytes, modifiedTimeMs: stat.mtimeMs });
}

async function writeSameVolumeReplacement(target: string, bytes: Uint8Array, suffix: string): Promise<void> {
  const stagingPath = path.join(path.dirname(target), `.${path.basename(target)}.${suffix}.${randomUUID()}.tmp`);
  const handle = await fs.open(stagingPath, 'wx');
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(stagingPath, target);
  } finally {
    await fs.rm(stagingPath, { force: true }).catch(() => {});
  }
}

async function prepareTransactionDirectory(canonicalPath: string, transactionId: string, stateRoot?: string): Promise<string> {
  const root = officeStateRoot(stateRoot);
  await ensureRealDirectory(root, true);
  const documentRoot = documentStateRoot(canonicalPath, stateRoot);
  await ensureRealDirectory(documentRoot);
  const txDir = transactionDirectory(canonicalPath, transactionId, stateRoot);
  await ensureRealDirectory(txDir);
  return txDir;
}

export async function transactionalWordEdit(input: TransactionalWordEditInput): Promise<TransactionalWordEditResult> {
  if (!input.principalId.trim() || !input.workSessionId.trim()) throw new Error('Office mutation owner must be explicit.');
  if (input.expectedSha256 && !shaPattern.test(input.expectedSha256)) throw new Error('expectedSha256 must be 64 lowercase hex characters.');

  const canonicalPath = path.resolve(input.canonicalPath);
  const extension = path.extname(canonicalPath).toLowerCase();
  if (extension !== '.docx') throw new Error('word_edit mutation v1 supports only .docx. Macro-enabled/template formats remain inspection-only.');

  const [originalBytes, originalStat] = await Promise.all([fs.readFile(canonicalPath), fs.stat(canonicalPath)]);
  const originalIdentity = createOfficeDocumentIdentity({ canonicalPath, bytes: originalBytes, modifiedTimeMs: originalStat.mtimeMs });
  if (input.expectedSha256 && input.expectedSha256 !== originalIdentity.sha256) {
    throw new Error(`OFFICE_CONFLICT: expected SHA-256 ${input.expectedSha256}, current ${originalIdentity.sha256}.`);
  }

  const originalInspection = inspectWordDocx({ canonicalPath, bytes: originalBytes, modifiedTimeMs: originalStat.mtimeMs });
  assertSafeMutationDocument(originalInspection);

  let tx = createOfficeTransaction({
    principalId: input.principalId,
    workSessionId: input.workSessionId,
    original: originalIdentity
  });
  tx = appendOfficeTransactionBackend(tx, 'ooxml');
  tx = transitionOfficeTransaction(tx, 'inspected');

  const txDir = await prepareTransactionDirectory(canonicalPath, tx.id, input.stateRoot);
  const backupPath = path.join(txDir, 'backup.docx');
  const workingPath = path.join(txDir, 'working.docx');
  const pdfPath = path.join(txDir, 'evidence.pdf');
  const recordPath = path.join(txDir, 'record.json');

  await fs.writeFile(backupPath, originalBytes, { flag: 'wx' });
  tx = { ...tx, backupPath };
  tx = transitionOfficeTransaction(tx, 'snapshotted');
  await fs.writeFile(workingPath, originalBytes, { flag: 'wx' });
  tx = { ...tx, workingCopyPath: workingPath };
  tx = transitionOfficeTransaction(tx, 'working');
  await persistTransaction(recordPath, { version: 1, transaction: tx, backupPath, documentPath: canonicalPath });

  let committed = false;
  let targetReplaced = false;
  let native: NativeWordValidationResult | undefined;
  try {
    const edited = editWordDocx(originalBytes, input.operations);
    if (input.maxWriteBytes !== undefined && edited.bytes.byteLength > input.maxWriteBytes) {
      throw new Error('Write exceeds maxWriteBytes (' + input.maxWriteBytes + ').');
    }
    await fs.writeFile(workingPath, edited.bytes, { flag: 'w' });
    tx = transitionOfficeTransaction(tx, 'patched');

    const workingStat = await fs.stat(workingPath);
    const inspection = inspectWordDocx({ canonicalPath: workingPath, bytes: edited.bytes, modifiedTimeMs: workingStat.mtimeMs });
    assertSafeMutationDocument(inspection);

    const acceptance = input.acceptance ?? {};
    const requiredHeadings = acceptance.preserveHeadingTexts ?? [];
    const headings = headingTexts(inspection);
    const remainingImages = imageRelationshipIds(inspection);
    const assertions = [
      { id: 'package_opens', passed: true, expected: true, actual: true },
      {
        id: 'required_headings_preserved',
        passed: requiredHeadings.every(text => headings.has(text)),
        expected: requiredHeadings.length,
        actual: requiredHeadings.filter(text => headings.has(text)).length
      },
      {
        id: 'equation_count',
        passed: inspection.equations.length >= (acceptance.minEquationCount ?? 0),
        expected: acceptance.minEquationCount ?? 0,
        actual: inspection.equations.length
      },
      {
        id: 'target_images_removed',
        passed: (acceptance.removedImageRelationshipIds ?? []).every(id => !remainingImages.has(id)),
        expected: 0,
        actual: (acceptance.removedImageRelationshipIds ?? []).filter(id => remainingImages.has(id)).length
      }
    ];

    if (acceptance.nativeWord) {
      const adapter = input.nativeAdapter ?? new NativeWordAdapter();
      if (!adapter.supported()) throw new Error('WORD_COM_UNAVAILABLE: native Word acceptance was required but this node is not Windows.');
      tx = appendOfficeTransactionBackend(tx, 'windows-com');
      native = await adapter.validateAndRender(workingPath, pdfPath, { exportPdf: acceptance.exportPdf ?? true });
      tx = transitionOfficeTransaction(tx, 'app-opened');
      tx = appendOfficeEvidence(tx, { kind: 'application-open', createdAt: new Date().toISOString(), backend: 'windows-com' });
      assertions.push({ id: 'document_opens', passed: native.ok, expected: true, actual: native.ok });
      if (acceptance.exportPdf ?? true) {
        tx = transitionOfficeTransaction(tx, 'rendered');
        const pdfStat = await fs.stat(pdfPath);
        tx = appendOfficeEvidence(tx, { kind: 'pdf', path: pdfPath, createdAt: new Date().toISOString(), backend: 'windows-com' });
        assertions.push({ id: 'pdf_render_nonempty', passed: pdfStat.size > 0, expected: true, actual: pdfStat.size > 0 });
      }
      if (acceptance.minEquationCount !== undefined && native.equations !== undefined) {
        assertions.push({
          id: 'native_omath_count',
          passed: native.equations >= acceptance.minEquationCount,
          expected: acceptance.minEquationCount,
          actual: native.equations
        });
      }
    }

    const validation = officeValidationResult(assertions);
    tx = transitionOfficeTransaction(tx, 'validated');
    tx = setOfficeValidation(tx, validation);
    requireOfficeValidationPass(validation);
    tx = transitionOfficeTransaction(tx, 'accepted');

    const currentIdentity = await identityFromFile(canonicalPath);
    tx = verifyOfficeCommitRevision(tx, currentIdentity);
    if (tx.state === 'conflict') {
      await persistTransaction(recordPath, { version: 1, transaction: tx, backupPath, documentPath: canonicalPath });
      throw new Error('OFFICE_CONFLICT: original document changed after inspection; commit refused.');
    }

    await writeSameVolumeReplacement(canonicalPath, edited.bytes, `commit-${tx.id}`);
    targetReplaced = true;
    const committedIdentity = await identityFromFile(canonicalPath);
    const committedTx = transitionOfficeTransaction(tx, 'committed');
    await persistTransaction(recordPath, {
      version: 1,
      transaction: committedTx,
      backupPath,
      documentPath: canonicalPath,
      committedIdentity
    });
    tx = committedTx;
    committed = true;

    return {
      transaction: tx,
      backupPath,
      committedIdentity,
      applied: edited.applied,
      ...(native ? { native } : {}),
      structural: {
        paragraphs: inspection.paragraphs.length,
        headings: inspection.headings.length,
        tables: inspection.tables.length,
        images: inspection.images.length,
        equations: inspection.equations.length,
        sections: inspection.sections.length
      }
    };
  } catch (error) {
    if (targetReplaced && !committed) {
      const backupBytes = await fs.readFile(backupPath);
      await writeSameVolumeReplacement(canonicalPath, backupBytes, `recovery-${tx.id}`);
      targetReplaced = false;
    }
    if (!committed && tx.state !== 'conflict' && tx.state !== 'failed' && tx.state !== 'rolled-back') {
      try {
        tx = transitionOfficeTransaction(tx, 'rollback-pending');
        tx = transitionOfficeTransaction(tx, 'rolled-back');
      } catch {
        // Preserve the original error. Before commit the original is untouched; post-swap failures restore the backup above.
      }
    }
    await persistTransaction(recordPath, { version: 1, transaction: tx, backupPath, documentPath: canonicalPath }).catch(() => {});
    throw error;
  }
}

export async function rollbackWordTransaction(input: {
  canonicalPath: string;
  transactionId: string;
  principalId: string;
  workSessionId: string;
  stateRoot?: string;
}): Promise<{ transactionId: string; restoredIdentity: ReturnType<typeof createOfficeDocumentIdentity>; backupPath: string; alreadyRestored: boolean }> {
  if (!/^[0-9a-f-]{36}$/i.test(input.transactionId)) throw new Error('Invalid Office transaction id.');
  if (!input.principalId.trim() || !input.workSessionId.trim()) throw new Error('Office rollback owner must be explicit.');

  const canonicalPath = path.resolve(input.canonicalPath);
  const txDir = transactionDirectory(canonicalPath, input.transactionId, input.stateRoot);
  await assertRealDirectory(officeStateRoot(input.stateRoot));
  await assertRealDirectory(documentStateRoot(canonicalPath, input.stateRoot));
  await assertRealDirectory(txDir);

  const recordPath = transactionRecordPath(canonicalPath, input.transactionId, input.stateRoot);
  const raw = JSON.parse(await fs.readFile(recordPath, 'utf8')) as StoredWordTransaction;
  if (raw.version !== 1 || raw.transaction.id !== input.transactionId) throw new Error('OFFICE_TRANSACTION_INVALID: transaction record mismatch.');
  if (path.resolve(raw.documentPath) !== canonicalPath) throw new Error('OFFICE_TRANSACTION_INVALID: transaction belongs to a different document.');
  if (raw.transaction.principalId !== input.principalId || raw.transaction.workSessionId !== input.workSessionId) {
    throw new Error('OFFICE_TRANSACTION_OWNER_MISMATCH: rollback is restricted to the principal and Work Session that created the transaction.');
  }
  if (raw.transaction.state !== 'committed' || !raw.committedIdentity) {
    throw new Error('OFFICE_TRANSACTION_NOT_ROLLBACKABLE: only a successfully committed Word transaction can be rolled back.');
  }

  const expectedBackupPath = path.join(txDir, 'backup.docx');
  if (path.resolve(raw.backupPath) !== path.resolve(expectedBackupPath)) {
    throw new Error('OFFICE_TRANSACTION_INVALID: backup path escaped the transaction state directory.');
  }

  const currentIdentity = await identityFromFile(canonicalPath);
  if (sameOfficeDocumentRevision(currentIdentity, raw.transaction.original)) {
    if (!raw.rollback) {
      raw.rollback = { restoredAt: new Date().toISOString(), restoredIdentity: currentIdentity };
      await persistTransaction(recordPath, raw);
    }
    return { transactionId: input.transactionId, restoredIdentity: currentIdentity, backupPath: raw.backupPath, alreadyRestored: true };
  }
  if (!sameOfficeDocumentRevision(currentIdentity, raw.committedIdentity)) {
    throw new Error('OFFICE_ROLLBACK_CONFLICT: document changed after this transaction committed; rollback refused to protect newer edits.');
  }

  const backupStat = await fs.lstat(raw.backupPath);
  if (backupStat.isSymbolicLink() || !backupStat.isFile()) {
    throw new Error('OFFICE_ROLLBACK_BACKUP_UNSAFE: recorded backup is missing, not a regular file, or is a symlink.');
  }
  const backupBytes = await fs.readFile(raw.backupPath);
  const backupIdentity = createOfficeDocumentIdentity({ canonicalPath, bytes: backupBytes });
  if (!sameOfficeDocumentRevision(backupIdentity, raw.transaction.original)) {
    throw new Error('OFFICE_ROLLBACK_BACKUP_MISMATCH: recorded backup no longer matches the original SHA-256.');
  }

  await writeSameVolumeReplacement(canonicalPath, backupBytes, `rollback-${input.transactionId}`);
  const restoredIdentity = await identityFromFile(canonicalPath);
  if (!sameOfficeDocumentRevision(restoredIdentity, raw.transaction.original)) {
    throw new Error('OFFICE_ROLLBACK_VERIFY_FAILED: restored file does not match the recorded original SHA-256.');
  }
  raw.rollback = { restoredAt: new Date().toISOString(), restoredIdentity };
  await persistTransaction(recordPath, raw);
  return { transactionId: input.transactionId, restoredIdentity, backupPath: raw.backupPath, alreadyRestored: false };
}
