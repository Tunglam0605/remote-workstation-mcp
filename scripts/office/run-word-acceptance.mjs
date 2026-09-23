import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sha256Bytes } from '../../dist/office/common/document-identity.js';
import { wordLinearTextToOmml } from '../../dist/office/word/equation.js';
import { inspectWordDocx } from '../../dist/office/word/inspector.js';
import { rollbackWordTransaction, transactionalWordEdit } from '../../dist/office/word/transactional-edit.js';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, '../..');
process.chdir(root);
const fixtureScript = path.join(scriptDir, 'create-word-acceptance-fixture.mjs');
const documentPath = execFileSync(process.execPath, [fixtureScript], { encoding: 'utf8' }).trim();
const acceptanceDir = path.dirname(documentPath);
const stateRoot = path.join(acceptanceDir, 'rwmcp-state');

try {
  const originalBytes = await fs.readFile(documentPath);
  const originalSha256 = sha256Bytes(originalBytes);
  const before = inspectWordDocx({ canonicalPath: documentPath, bytes: originalBytes });
  const target = before.paragraphs.find(item => item.text === 'AI decoded equation target');
  const image = before.images.find(item => item.relationshipId === 'rIdImage1') ?? before.images[0];
  if (!target || !image?.relationshipId) throw new Error('Acceptance fixture did not expose the expected paragraph/image locators.');
  const locator = target.locator.stableId ? { stableId: target.locator.stableId } : { structuralPath: target.locator.structuralPath };

  const applied = await transactionalWordEdit({
    canonicalPath: documentPath,
    principalId: 'acceptance-local',
    workSessionId: '11111111-1111-4111-8111-111111111111',
    expectedSha256: originalSha256,
    stateRoot,
    operations: [
      { type: 'remove_image', relationshipId: image.relationshipId },
      { type: 'replace_paragraph_text', locator, text: 'AI decoded text: equation follows.' },
      { type: 'insert_omml', locator, omml: wordLinearTextToOmml('x^2+2*x+1'), mode: 'append' }
    ],
    acceptance: {
      nativeWord: true,
      exportPdf: true,
      minEquationCount: 1,
      removedImageRelationshipIds: [image.relationshipId],
      preserveHeadingTexts: ['RWMCP Office Acceptance']
    }
  });

  const afterBytes = await fs.readFile(documentPath);
  const after = inspectWordDocx({ canonicalPath: documentPath, bytes: afterBytes });
  if (after.images.some(item => item.relationshipId === image.relationshipId)) throw new Error('Acceptance failed: target image still present.');
  if (after.equations.length < 1) throw new Error('Acceptance failed: no native OMML equation after mutation.');
  if (!after.headings.some(item => item.text === 'RWMCP Office Acceptance')) throw new Error('Acceptance failed: required heading changed.');

  const rollback = await rollbackWordTransaction({ canonicalPath: documentPath, transactionId: applied.transaction.id, principalId: 'acceptance-local', workSessionId: '11111111-1111-4111-8111-111111111111', stateRoot });
  const restoredBytes = await fs.readFile(documentPath);
  const restored = inspectWordDocx({ canonicalPath: documentPath, bytes: restoredBytes });
  if (rollback.restoredIdentity.sha256 !== originalSha256 || sha256Bytes(restoredBytes) !== originalSha256) {
    throw new Error('Acceptance failed: rollback did not restore the exact original SHA-256.');
  }

  console.log(JSON.stringify({
    ok: true,
    wordVersion: applied.native?.wordVersion,
    pages: applied.native?.pages,
    nativeEquationCount: applied.native?.equations,
    pdfPath: applied.native?.pdfPath,
    pdfBytes: applied.native?.pdfPath ? (await fs.stat(applied.native.pdfPath)).size : 0,
    transactionId: applied.transaction.id,
    transactionState: applied.transaction.state,
    backupPath: applied.backupPath,
    originalSha256,
    committedSha256: applied.committedIdentity.sha256,
    postEdit: { headings: after.headings.length, images: after.images.length, equations: after.equations.length },
    rollback: { restoredSha256: rollback.restoredIdentity.sha256, images: restored.images.length, equations: restored.equations.length }
  }, null, 2));
} finally {
  if (process.env.RWMCP_OFFICE_ACCEPTANCE_KEEP !== '1') {
    await fs.rm(acceptanceDir, { recursive: true, force: true }).catch(() => {});
  }
}
