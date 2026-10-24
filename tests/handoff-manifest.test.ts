import assert from 'node:assert/strict';
import test from 'node:test';
import { validateHandoffManifest } from '../src/adapters/engineering/handoff-manifest.js';

const digest = 'a'.repeat(64);
const valid = {
  schemaVersion: 1, jobId: 'job-1', sourceNodeId: 'ssd', destinationNodeId: 'laptop',
  sourceWorkspace: 'projects', destinationWorkspace: 'builds', projectId: 'stm32',
  sourceRevision: 'sha256-commit-a1', role: 'source', toolchainProfileId: 'keil-approved',
  createdAt: '2026-10-24T01:01:00Z', files: [{ relativePath: 'Core/Src/main.c', bytes: 21, sha256: digest }]
};

test('handoff manifest accepts exact portable relative paths and nonzero versioned contract', () => {
  assert.deepEqual(validateHandoffManifest(valid).files, valid.files);
  assert.throws(() => validateHandoffManifest({ ...valid, schemaVersion: 2 }), /invalid|schema|version/i);
  assert.throws(() => validateHandoffManifest({ ...valid, jobId: '' }), /invalid|string|identifier/i);
});

test('handoff manifest denies traversal, absolute/Windows paths, duplicates and bad hashes', () => {
  for (const relativePath of ['../secret.txt', '/etc/passwd', 'C:/Windows/a', 'C:\\Windows\\a', 'x\\y.txt', 'x//y.txt', 'x/./y.txt', '.env', '.git/config', 'Core/CON', 'Core/NUL.txt', 'Core/com1.bin', 'Core/main.c.', 'Core/new\nline.c']) {
    assert.throws(() => validateHandoffManifest({ ...valid, files: [{ relativePath, bytes: 1, sha256: digest }] }), /path|secret|invalid|denied/i, relativePath);
  }
  assert.throws(() => validateHandoffManifest({ ...valid, files: [{ relativePath: 'a.bin', bytes: 1, sha256: digest }, { relativePath: 'A.bin', bytes: 1, sha256: digest }] }), /duplicate/i);
  assert.throws(() => validateHandoffManifest({ ...valid, files: [{ relativePath: 'a.bin', bytes: 1, sha256: '123' }] }), /invalid/i);
});

test('handoff manifest bounds total unpacked size and entry count', () => {
  assert.throws(() => validateHandoffManifest({ ...valid, files: [{ relativePath: 'huge.bin', bytes: 600 * 1024 * 1024, sha256: digest }] }), /size|limit|too big/i);
  assert.throws(() => validateHandoffManifest({ ...valid, files: Array.from({ length: 2049 }, (_, i) => ({ relativePath: `s${i}`, bytes: 0, sha256: digest })) }), /limit|count|too big/i);
});
