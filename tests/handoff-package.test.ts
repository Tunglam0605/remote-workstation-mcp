import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { strToU8, zipSync } from 'fflate';
import { acceptHandoff, packageHandoff } from '../src/adapters/engineering/handoff-package.js';

const draft = {
  schemaVersion: 1 as const, jobId: 'job-a', sourceNodeId: 'ssd', destinationNodeId: 'laptop',
  sourceWorkspace: 'src', destinationWorkspace: 'dst', projectId: 'laser-f4',
  sourceRevision: 'sha256:abc123', role: 'source' as const,
  createdAt: '2026-10-24T01:01:00Z'
};
const sha = (bytes: Uint8Array) => crypto.createHash('sha256').update(bytes).digest('hex');
const expected = {
  expectedDestinationNodeId: draft.destinationNodeId,
  expectedDestinationWorkspace: draft.destinationWorkspace,
  expectedSourceNodeId: draft.sourceNodeId,
  expectedProjectId: draft.projectId,
  expectedJobId: draft.jobId
};

async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-handoff-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'); const destination = path.join(root, 'dest');
  await fs.mkdir(path.join(source, 'Core', 'Src'), { recursive: true });
  await fs.mkdir(path.join(source, 'out'), { recursive: true });
  await fs.mkdir(path.join(destination, 'incoming'), { recursive: true });
  await fs.writeFile(path.join(source, 'Core', 'Src', 'main.c'), 'int main(void) {return 0;}\n');
  return { root, source, destination };
}

test('handoff packs deterministic verified manifest+files and atomically accepts into new project directory', async t => {
  const { source, destination } = await fixture(t);
  const input = { workspaceRoot: source, projectRelativePath: '.', manifestDraft: draft, includedFiles: ['Core/Src/main.c'] };
  const first = await packageHandoff({ ...input, outputRelativePath: 'out/one.zip' });
  const second = await packageHandoff({ ...input, outputRelativePath: 'out/two.zip' });
  assert.equal(first.sha256, second.sha256);
  await assert.rejects(packageHandoff({ ...input, outputRelativePath: 'out/one.zip' }), /exists|conflict/i);
  assert.equal(sha(await fs.readFile(path.join(source, 'out', 'one.zip'))), first.sha256);
  assert.equal(first.manifest.files.length, 1);
  const archive = await fs.readFile(path.join(source, 'out', 'one.zip'));
  await fs.copyFile(path.join(source, 'out', 'one.zip'), path.join(destination, 'incoming', 'one.zip'));
  await assert.rejects(acceptHandoff({ workspaceRoot: destination, archiveRelativePath: 'incoming/one.zip', expectedSha256: sha(archive), destinationRelativeBase: 'incoming', expectedRole: 'source', ...expected, beforePromote: async () => { throw new Error('Grant revoked before promotion'); } }), /Grant revoked/);
  await assert.rejects(fs.stat(path.join(destination, 'incoming', 'laser-f4-source-job-a')), /ENOENT/);
  const accepted = await acceptHandoff({ workspaceRoot: destination, archiveRelativePath: 'incoming/one.zip', expectedSha256: sha(archive), destinationRelativeBase: 'incoming', expectedRole: 'source', ...expected });
  assert.match(await fs.readFile(path.join(destination, accepted.acceptedPath, 'Core', 'Src', 'main.c'), 'utf8'), /int main/);
  await assert.rejects(acceptHandoff({ workspaceRoot: destination, archiveRelativePath: 'incoming/one.zip', expectedSha256: sha(archive), destinationRelativeBase: 'incoming', expectedRole: 'source', ...expected }), /exists|conflict/i);
  await assert.rejects(acceptHandoff({ workspaceRoot: destination, archiveRelativePath: 'incoming/one.zip', expectedSha256: sha(archive), destinationRelativeBase: 'incoming', expectedRole: 'source', ...expected, expectedDestinationNodeId: 'other' }), /identity/i);
});

test('handoff denies symlinked files, default secret paths, mismatched digest and archive traversal', async t => {
  const { source, destination } = await fixture(t);
  // Test a Windows reparse point without requiring the Administrator or
  // Developer Mode privilege needed for file symlinks. On hosts supporting
  // native file symlinks, retain the stronger original test as well.
  let linkedPath = 'linked.c';
  try {
    await fs.symlink(path.join(source, 'Core', 'Src', 'main.c'), path.join(source, linkedPath));
  } catch (error) {
    if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    linkedPath = 'linked-dir/main.c';
    await fs.symlink(path.join(source, 'Core', 'Src'), path.join(source, 'linked-dir'), 'junction');
  }
  await assert.rejects(packageHandoff({ workspaceRoot: source, projectRelativePath: '.', manifestDraft: draft, includedFiles: [linkedPath], outputRelativePath: 'out/symlink.zip' }), /symlink|reparse/i);
  await fs.writeFile(path.join(source, '.env'), 'TOKEN=secret');
  await assert.rejects(packageHandoff({ workspaceRoot: source, projectRelativePath: '.', manifestDraft: draft, includedFiles: ['.env'], outputRelativePath: 'out/secret.zip' }), /secret|excluded/i);
  const archive = zipSync({ 'manifest.json': strToU8(JSON.stringify({ ...draft, files: [{ relativePath: 'a.c', bytes: 1, sha256: 'a'.repeat(64) }] })), 'files/../evil': strToU8('x') }, { mtime: new Date('2000-01-01T00:00:00Z') });
  await fs.writeFile(path.join(destination, 'incoming', 'forged.zip'), archive);
  await assert.rejects(acceptHandoff({ workspaceRoot: destination, archiveRelativePath: 'incoming/forged.zip', expectedSha256: sha(archive), destinationRelativeBase: 'incoming', expectedRole: 'source', ...expected }), /path|entry|archive/i);
  await assert.rejects(acceptHandoff({ workspaceRoot: destination, archiveRelativePath: 'incoming/forged.zip', expectedSha256: 'f'.repeat(64), destinationRelativeBase: 'incoming', expectedRole: 'source', ...expected }), /checksum|digest|SHA/i);
  const compressed = zipSync({
    'manifest.json': strToU8(JSON.stringify({ ...draft, files: [{ relativePath: 'a.c', bytes: 1024 * 1024, sha256: sha(new Uint8Array(1024 * 1024)) }] })),
    'files/a.c': new Uint8Array(1024 * 1024)
  }, { level: 9, mtime: new Date('2000-01-01T00:00:00Z') });
  await fs.writeFile(path.join(destination, 'incoming', 'compressed.zip'), compressed);
  await assert.rejects(acceptHandoff({ workspaceRoot: destination, archiveRelativePath: 'incoming/compressed.zip', expectedSha256: sha(compressed), destinationRelativeBase: 'incoming', expectedRole: 'source', ...expected }), /compressed|bomb/i);
  const stored = zipSync({
    'manifest.json': strToU8(JSON.stringify({ ...draft, files: [{ relativePath: 'a.c', bytes: 1, sha256: sha(strToU8('x')) }] })),
    'files/a.c': strToU8('x')
  }, { level: 0, mtime: new Date('2000-01-01T00:00:00Z') });
  const mutated = Buffer.from(stored);
  const central = mutated.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.ok(central >= 0);
  mutated.writeUInt32LE(1, central + 24); // forge uncompressed size while compressed size remains larger
  await fs.writeFile(path.join(destination, 'incoming', 'forged-size.zip'), mutated);
  await assert.rejects(acceptHandoff({ workspaceRoot: destination, archiveRelativePath: 'incoming/forged-size.zip', expectedSha256: sha(mutated), destinationRelativeBase: 'incoming', expectedRole: 'source', ...expected }), /forged|size/i);
});
