import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { strToU8, zipSync } from 'fflate';
import { sha256Bytes } from '../src/office/common/document-identity.js';
import { inspectWordDocx } from '../src/office/word/inspector.js';
import { rollbackWordTransaction, transactionalWordEdit } from '../src/office/word/transactional-edit.js';
import { wordLinearTextToOmml } from '../src/office/word/equation.js';

const OWNER = 'test-principal';
const SESSION = '11111111-1111-4111-8111-111111111111';
const xml = (value: string) => strToU8(value);

function acceptanceDocx(): Uint8Array {
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
        <w:p w14:paraId="00ABC123"><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Keep Heading</w:t></w:r></w:p>
        <w:p w14:paraId="00ABC124"><w:r><w:t>Equation target</w:t></w:r></w:p>
        <w:p w14:paraId="00ABC125"><w:r><w:drawing><wp:inline><wp:docPr id="1" name="Picture"/><a:graphic><a:graphicData><a:blip r:embed="rIdImage1"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>
        <w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>
      </w:body>
    </w:document>`),
    'word/styles.xml': xml(`<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style>
    </w:styles>`),
    'word/_rels/document.xml.rels': xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
      <Relationship Id="rIdImage1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>
    </Relationships>`),
    'word/media/image1.png': Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])
  }, { level: 0 });
}

async function tempDoc(): Promise<{ dir: string; file: string; stateRoot: string; original: Uint8Array }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-word-tx-test-'));
  const file = path.join(dir, 'document.docx');
  const stateRoot = path.join(dir, 'owner-state');
  const original = acceptanceDocx();
  await fs.writeFile(file, original);
  return { dir, file, stateRoot, original };
}

async function commitSimpleEdit(fixture: Awaited<ReturnType<typeof tempDoc>>) {
  return await transactionalWordEdit({
    canonicalPath: fixture.file,
    principalId: OWNER,
    workSessionId: SESSION,
    stateRoot: fixture.stateRoot,
    operations: [{ type: 'replace_paragraph_text', locator: { paraId: '00ABC124' }, text: 'Committed edit' }],
    acceptance: { nativeWord: false, preserveHeadingTexts: ['Keep Heading'] }
  });
}

test('transactional Word edit commits after acceptance and owner rollback restores exact original', async (t) => {
  const fixture = await tempDoc();
  t.after(async () => fs.rm(fixture.dir, { recursive: true, force: true }));

  let nativeCalls = 0;
  const nativeAdapter = {
    supported: () => true,
    validateAndRender: async (documentPath: string, outputPdfPath: string) => {
      nativeCalls += 1;
      const bytes = await fs.readFile(documentPath);
      const inspected = inspectWordDocx({ canonicalPath: documentPath, bytes });
      await fs.writeFile(outputPdfPath, Buffer.from('%PDF-1.7\nmock\n'));
      return { ok: true, wordVersion: 'test', pages: 1, equations: inspected.equations.length, pdfPath: outputPdfPath };
    }
  };

  const originalSha = sha256Bytes(fixture.original);
  const applied = await transactionalWordEdit({
    canonicalPath: fixture.file,
    principalId: OWNER,
    workSessionId: SESSION,
    stateRoot: fixture.stateRoot,
    expectedSha256: originalSha,
    maxWriteBytes: 10_000_000,
    nativeAdapter,
    operations: [
      { type: 'remove_image', relationshipId: 'rIdImage1' },
      { type: 'insert_omml', locator: { paraId: '00ABC124' }, omml: wordLinearTextToOmml('x+1'), mode: 'replace-content' }
    ],
    acceptance: {
      nativeWord: true,
      exportPdf: true,
      minEquationCount: 1,
      removedImageRelationshipIds: ['rIdImage1'],
      preserveHeadingTexts: ['Keep Heading']
    }
  });

  assert.equal(applied.transaction.state, 'committed');
  assert.equal(applied.transaction.validation?.passed, true);
  assert.equal(applied.structural.images, 0);
  assert.equal(applied.structural.equations, 1);
  assert.equal(nativeCalls, 1);
  assert.equal(sha256Bytes(await fs.readFile(applied.backupPath)), originalSha);
  assert.notEqual(applied.committedIdentity.sha256, originalSha);
  await assert.rejects(fs.stat(path.join(fixture.dir, '.rwmcp-office')), /ENOENT/);

  const rolledBack = await rollbackWordTransaction({
    canonicalPath: fixture.file,
    transactionId: applied.transaction.id,
    principalId: OWNER,
    workSessionId: SESSION,
    stateRoot: fixture.stateRoot
  });
  assert.equal(rolledBack.alreadyRestored, false);
  assert.equal(rolledBack.restoredIdentity.sha256, originalSha);

  const secondRollback = await rollbackWordTransaction({
    canonicalPath: fixture.file,
    transactionId: applied.transaction.id,
    principalId: OWNER,
    workSessionId: SESSION,
    stateRoot: fixture.stateRoot
  });
  assert.equal(secondRollback.alreadyRestored, true);
});

test('failed Word acceptance leaves original byte-identical while evidence stays in owner-local state', async (t) => {
  const fixture = await tempDoc();
  t.after(async () => fs.rm(fixture.dir, { recursive: true, force: true }));
  const originalSha = sha256Bytes(fixture.original);

  await assert.rejects(
    transactionalWordEdit({
      canonicalPath: fixture.file,
      principalId: OWNER,
      workSessionId: SESSION,
      stateRoot: fixture.stateRoot,
      operations: [{ type: 'replace_paragraph_text', locator: { paraId: '00ABC123' }, text: 'Changed Heading' }],
      acceptance: { nativeWord: false, preserveHeadingTexts: ['Keep Heading'] }
    }),
    /OFFICE_ACCEPTANCE_FAILED/
  );

  assert.equal(sha256Bytes(await fs.readFile(fixture.file)), originalSha);
  await assert.rejects(fs.stat(path.join(fixture.dir, '.rwmcp-office')), /ENOENT/);
  assert.equal((await fs.stat(fixture.stateRoot)).isDirectory(), true);
});

test('Word transaction rejects stale expected SHA before creating state artifacts', async (t) => {
  const fixture = await tempDoc();
  t.after(async () => fs.rm(fixture.dir, { recursive: true, force: true }));

  await assert.rejects(
    transactionalWordEdit({
      canonicalPath: fixture.file,
      principalId: OWNER,
      workSessionId: SESSION,
      stateRoot: fixture.stateRoot,
      expectedSha256: '0'.repeat(64),
      operations: [{ type: 'replace_paragraph_text', locator: { paraId: '00ABC124' }, text: 'Nope' }],
      acceptance: { nativeWord: false }
    }),
    /OFFICE_CONFLICT/
  );

  assert.equal(sha256Bytes(await fs.readFile(fixture.file)), sha256Bytes(fixture.original));
  await assert.rejects(fs.stat(fixture.stateRoot), /ENOENT/);
});

test('Word rollback is Work Session owned and refuses to overwrite newer edits', async (t) => {
  const fixture = await tempDoc();
  t.after(async () => fs.rm(fixture.dir, { recursive: true, force: true }));
  const applied = await commitSimpleEdit(fixture);

  await assert.rejects(
    rollbackWordTransaction({
      canonicalPath: fixture.file,
      transactionId: applied.transaction.id,
      principalId: OWNER,
      workSessionId: '22222222-2222-4222-8222-222222222222',
      stateRoot: fixture.stateRoot
    }),
    /OFFICE_TRANSACTION_OWNER_MISMATCH/
  );

  const newerBytes = Buffer.concat([await fs.readFile(fixture.file), Buffer.from([0])]);
  await fs.writeFile(fixture.file, newerBytes);
  const newerSha = sha256Bytes(newerBytes);

  await assert.rejects(
    rollbackWordTransaction({
      canonicalPath: fixture.file,
      transactionId: applied.transaction.id,
      principalId: OWNER,
      workSessionId: SESSION,
      stateRoot: fixture.stateRoot
    }),
    /OFFICE_ROLLBACK_CONFLICT/
  );
  assert.equal(sha256Bytes(await fs.readFile(fixture.file)), newerSha);
});
