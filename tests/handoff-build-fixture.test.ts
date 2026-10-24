import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { acceptHandoff, packageHandoff } from '../src/adapters/engineering/handoff-package.js';
import { validateHandoffBuildIntent } from '../src/adapters/engineering/handoff-build-preflight.js';

const sha = (bytes: Uint8Array) => crypto.createHash('sha256').update(bytes).digest('hex');
const createdAt = '2026-10-24T02:00:00Z';

test('disposable SSD → Windows trusted build fixture → SSD artifact has verified two-way receipts', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-roundtrip-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const ssd = path.join(root, 'ssd'); const windows = path.join(root, 'windows');
  for (const base of [ssd, windows]) {
    await fs.mkdir(path.join(base, 'incoming'), { recursive: true });
    await fs.mkdir(path.join(base, 'exports'), { recursive: true });
  }
  await fs.mkdir(path.join(ssd, 'project'), { recursive: true });
  await fs.writeFile(path.join(ssd, 'project', 'main.c'), 'int main(void) {return 0;}\n');
  const sourceRevision = sha(await fs.readFile(path.join(ssd, 'project', 'main.c')));
  const first = await packageHandoff({
    workspaceRoot: ssd, projectRelativePath: 'project', outputRelativePath: 'exports/source.zip',
    includedFiles: ['main.c'],
    manifestDraft: {
      schemaVersion: 1, jobId: 'build-job', sourceNodeId: 'ssd', destinationNodeId: 'windows',
      sourceWorkspace: 'projects', destinationWorkspace: 'builds', projectId: 'f4',
      sourceRevision, role: 'source', createdAt, toolchainProfileId: 'approved-cmake-f4'
    }
  });
  await fs.copyFile(path.join(ssd, first.relativePath), path.join(windows, 'incoming', 'source.zip'));
  const receipt = await acceptHandoff({
    workspaceRoot: windows, archiveRelativePath: 'incoming/source.zip', expectedSha256: first.sha256,
    destinationRelativeBase: 'incoming', expectedRole: 'source', expectedSourceNodeId: 'ssd',
    expectedDestinationNodeId: 'windows', expectedDestinationWorkspace: 'builds', expectedProjectId: 'f4', expectedJobId: 'build-job'
  });
  const profile = validateHandoffBuildIntent({
    manifest: receipt.manifest, localNodeId: 'windows', workspaceId: 'builds', requestedProfileId: 'approved-cmake-f4',
    requestedTarget: 'STM32F407', cleanSnapshot: true, buildHooks: [], sourceRevision,
    ownerProfiles: [{ id: 'approved-cmake-f4', target: 'STM32F407', projectId: 'f4', sourceNodeId: 'ssd', sourceRevision, allowed: true }]
  });
  assert.equal(profile.eligible, true);
  // Simulated trusted toolchain output only: no process execution and no real firmware flash.
  await fs.writeFile(path.join(windows, 'exports', 'firmware.bin'), new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3]));
  const builtDigest = sha(await fs.readFile(path.join(windows, 'exports', 'firmware.bin')));
  const back = await packageHandoff({
    workspaceRoot: windows, projectRelativePath: 'exports', outputRelativePath: 'exports/result.zip', includedFiles: ['firmware.bin'],
    manifestDraft: {
      schemaVersion: 1, jobId: 'return-job', sourceNodeId: 'windows', destinationNodeId: 'ssd',
      sourceWorkspace: 'builds', destinationWorkspace: 'projects', projectId: 'f4',
      sourceRevision, role: 'build_artifacts', createdAt, toolchainProfileId: profile.profileId
    }
  });
  await fs.copyFile(path.join(windows, back.relativePath), path.join(ssd, 'incoming', 'result.zip'));
  const returned = await acceptHandoff({
    workspaceRoot: ssd, archiveRelativePath: 'incoming/result.zip', expectedSha256: back.sha256,
    destinationRelativeBase: 'incoming', expectedRole: 'build_artifacts', expectedSourceNodeId: 'windows',
    expectedDestinationNodeId: 'ssd', expectedDestinationWorkspace: 'projects', expectedProjectId: 'f4', expectedJobId: 'return-job'
  });
  assert.equal(sha(await fs.readFile(path.join(ssd, returned.acceptedPath, 'firmware.bin'))), builtDigest);
  assert.equal(sha(await fs.readFile(path.join(ssd, 'project', 'main.c'))), sourceRevision);
});
