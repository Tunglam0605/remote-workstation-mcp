import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  OfficeCapabilityMatrix,
  currentOfficeCapabilityMatrix
} from '../src/office/common/capability-matrix.js';
import {
  createOfficeDocumentIdentity,
  normalizeCanonicalOfficePath,
  sameOfficeDocumentRevision
} from '../src/office/common/document-identity.js';
import { officeFileResourceKey } from '../src/office/common/resource-keys.js';
import { OfficeSessionStore } from '../src/office/common/session-store.js';
import {
  createOfficeTransaction,
  transitionOfficeTransaction,
  verifyOfficeCommitRevision
} from '../src/office/common/transaction.js';
import { officeValidationResult, requireOfficeValidationPass } from '../src/office/common/validation.js';

test('Office capability matrix never silently downgrades required semantics', () => {
  const matrix = new OfficeCapabilityMatrix([
    {
      id: 'ooxml',
      status: 'available',
      domains: ['word'],
      capabilities: ['word.inspect', 'word.edit'],
      nativeApplication: false,
      headless: true
    },
    {
      id: 'windows-com',
      status: 'available',
      domains: ['word'],
      capabilities: ['word.inspect', 'word.equation.native-verify', 'word.render.pdf'],
      nativeApplication: true,
      headless: false
    }
  ]);

  assert.equal(matrix.select({ domain: 'word', capabilities: ['word.inspect'] }).id, 'ooxml');
  assert.equal(
    matrix.select({ domain: 'word', capabilities: ['word.equation.native-verify'] }).id,
    'windows-com'
  );
  assert.throws(
    () => matrix.select({
      domain: 'word',
      capabilities: ['word.equation.native-verify'],
      allowedBackends: ['ooxml']
    }),
    /OFFICE_BACKEND_UNAVAILABLE/
  );
});

test('Current Office matrix advertises Word OOXML inspection without pretending native engines are implemented', () => {
  const windows = currentOfficeCapabilityMatrix('win32').list();
  assert.equal(windows.find(item => item.id === 'windows-com')?.status, 'not-implemented');
  assert.equal(windows.find(item => item.id === 'ooxml')?.status, 'available');
  assert.deepEqual(windows.find(item => item.id === 'ooxml')?.capabilities, ['package.inspect', 'package.validate', 'word.inspect']);

  const linux = currentOfficeCapabilityMatrix('linux').list();
  assert.equal(linux.find(item => item.id === 'windows-com')?.status, 'unavailable');
});

test('Office document identity is content-addressed and canonical-path aware', () => {
  const first = createOfficeDocumentIdentity({
    canonicalPath: path.join(process.cwd(), 'Example.docx'),
    bytes: Buffer.from('revision-a')
  });
  const same = createOfficeDocumentIdentity({
    canonicalPath: path.join(process.cwd(), 'Example.docx'),
    bytes: Buffer.from('revision-a')
  });
  const changed = createOfficeDocumentIdentity({
    canonicalPath: path.join(process.cwd(), 'Example.docx'),
    bytes: Buffer.from('revision-b')
  });

  assert.equal(sameOfficeDocumentRevision(first, same), true);
  assert.equal(sameOfficeDocumentRevision(first, changed), false);
  assert.equal(first.sha256.length, 64);
  assert.equal(first.sizeBytes, Buffer.byteLength('revision-a'));
});

test('Office resource keys are stable for a canonical document path', () => {
  const input = path.join(process.cwd(), 'Docs', '..', 'Docs', 'Report.docx');
  const canonical = normalizeCanonicalOfficePath(input);
  assert.equal(officeFileResourceKey(input), `office-file:${canonical}`);
});

test('Office sessions are scoped to principal plus Work Session', () => {
  const store = new OfficeSessionStore();
  const identity = createOfficeDocumentIdentity({
    canonicalPath: path.join(process.cwd(), 'Report.docx'),
    bytes: Buffer.from('doc')
  });
  const session = store.create({
    principalId: 'openai-tunnel',
    workSessionId: '11111111-1111-4111-8111-111111111111',
    domain: 'word',
    workspace: 'projects',
    documentPath: 'Report.docx',
    mode: 'write',
    originalIdentity: identity
  });

  assert.equal(store.inspect(session.id, 'openai-tunnel', session.workSessionId).status, 'open');
  assert.throws(
    () => store.inspect(session.id, 'openai-tunnel', '22222222-2222-4222-8222-222222222222'),
    /Unknown Office session/
  );
  assert.equal(store.close(session.id, 'openai-tunnel', session.workSessionId).status, 'closed');
});

test('Office transaction enforces ordered acceptance and detects optimistic concurrency conflicts', () => {
  const original = createOfficeDocumentIdentity({
    canonicalPath: path.join(process.cwd(), 'Report.docx'),
    bytes: Buffer.from('original')
  });
  let tx = createOfficeTransaction({
    principalId: 'openai-tunnel',
    workSessionId: '11111111-1111-4111-8111-111111111111',
    original,
    now: new Date('2026-09-23T12:00:00Z')
  });

  for (const state of ['inspected', 'snapshotted', 'working', 'patched', 'validated', 'accepted'] as const) {
    tx = transitionOfficeTransaction(tx, state, new Date('2026-09-23T12:01:00Z'));
  }
  assert.equal(verifyOfficeCommitRevision(tx, original).state, 'accepted');

  const concurrentEdit = createOfficeDocumentIdentity({
    canonicalPath: original.canonicalPath,
    bytes: Buffer.from('changed-by-user')
  });
  assert.equal(verifyOfficeCommitRevision(tx, concurrentEdit).state, 'conflict');
  assert.throws(() => transitionOfficeTransaction(tx, 'working'), /Invalid Office transaction transition/);
});

test('Office validation is a typed assertion gate', () => {
  const pass = officeValidationResult([
    { id: 'package-valid', passed: true },
    { id: 'required-heading-preserved', passed: true }
  ]);
  assert.equal(pass.passed, true);
  assert.doesNotThrow(() => requireOfficeValidationPass(pass));

  const fail = officeValidationResult([
    { id: 'package-valid', passed: true },
    { id: 'native-equation', passed: false }
  ]);
  assert.equal(fail.passed, false);
  assert.throws(() => requireOfficeValidationPass(fail), /native-equation/);
});
