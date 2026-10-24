import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { acceptHandoff, packageHandoff } from '../src/adapters/engineering/handoff-package.js';
import { OwnerHandoffBuildProfiles, verifyAcceptedSourceSnapshot } from '../src/adapters/engineering/handoff-trusted-preflight.js';

test('trusted build preflight detects modified, injected or symlinked received source files', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-build-trust-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'); const dest = path.join(root, 'dest');
  await fs.mkdir(path.join(source, 'exports'), { recursive: true });
  await fs.mkdir(path.join(dest, 'incoming'), { recursive: true });
  await fs.writeFile(path.join(source, 'main.c'), 'int main(void) {return 0;}\n');
  const packed = await packageHandoff({
    workspaceRoot: source, projectRelativePath: '.', outputRelativePath: 'exports/one.zip',
    includedFiles: ['main.c'],
    manifestDraft: { schemaVersion: 1, jobId: 'j1', sourceNodeId: 'ssd', destinationNodeId: 'win',
      sourceWorkspace: 'src', destinationWorkspace: 'dst', projectId: 'f4', sourceRevision: 'abc',
      role: 'source', toolchainProfileId: 'trusted-f4', createdAt: '2026-10-24T03:00:00Z' }
  });
  await fs.copyFile(path.join(source, packed.relativePath), path.join(dest, 'incoming', 'one.zip'));
  const accepted = await acceptHandoff({ workspaceRoot: dest, archiveRelativePath: 'incoming/one.zip',
    expectedSha256: packed.sha256, destinationRelativeBase: 'incoming', expectedRole: 'source',
    expectedSourceNodeId: 'ssd', expectedDestinationNodeId: 'win', expectedDestinationWorkspace: 'dst',
    expectedProjectId: 'f4', expectedJobId: 'j1' });
  assert.equal((await verifyAcceptedSourceSnapshot(dest, accepted.acceptedPath)).sourceRevision, 'abc');

  const received = path.join(dest, ...accepted.acceptedPath.split('/'));
  await fs.writeFile(path.join(received, 'main.c'), 'int tampered;\n');
  await assert.rejects(verifyAcceptedSourceSnapshot(dest, accepted.acceptedPath), /changed|checksum|modified/i);
  await fs.writeFile(path.join(received, 'main.c'), 'int main(void) {return 0;}\n');
  await fs.writeFile(path.join(received, 'extra-build-hook.sh'), '#!/bin/sh');
  await assert.rejects(verifyAcceptedSourceSnapshot(dest, accepted.acceptedPath), /unexpected|unlisted/i);
  await fs.unlink(path.join(received, 'extra-build-hook.sh'));
  await fs.symlink(path.join(source, 'main.c'), path.join(received, 'rogue.c'));
  await assert.rejects(verifyAcceptedSourceSnapshot(dest, accepted.acceptedPath), /symlink|reparse/i);
});

test('owner build profile must come from a separate local private registry, not incoming source', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-owner-profile-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const location = path.join(root, 'private-profiles.json');
  const registry = new OwnerHandoffBuildProfiles(location);
  await assert.rejects(registry.load(), /owner|registry|profile/i);
  const values = { schemaVersion: 1, profiles: [{ id: 'trusted-f4', projectId: 'f4', target: 'STM32F407', sourceNodeId: 'ssd', sourceRevision: 'abc', destinationWorkspace: 'dst', allowed: true }] };
  await fs.writeFile(location, JSON.stringify(values), { mode: 0o600 });
  const loaded = await registry.load();
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0]?.id, 'trusted-f4');
  await fs.writeFile(location, JSON.stringify({ ...values, injected: true }));
  await assert.rejects(registry.load(), /unrecognized|invalid|schema|object/i);
});
