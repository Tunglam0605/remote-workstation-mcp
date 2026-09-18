import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ArtifactIntegrityAdapter } from '../src/adapters/engineering/artifact-integrity.js';
import { ArtifactTransferAdapter } from '../src/adapters/engineering/artifact-transfer.js';
import type { PolicyConfig } from '../src/model.js';
import { PolicyEngine } from '../src/policy.js';
import { PathGuard } from '../src/security/path-guard.js';

function config(root: string): PolicyConfig {
  return {
    version: 1,
    mode: 'workspace',
    workspaces: [
      { id: 'source', root: path.join(root, 'source'), readOnly: false },
      { id: 'dest', root: path.join(root, 'dest'), readOnly: false }
    ],
    filesystem: { maxReadBytes: 1024 * 1024, maxWriteBytes: 1024 * 1024 },
    process: { allowExecutables: [], inheritEnv: ['PATH'], maxOutputBytes: 262144, maxRuntimeMs: 600000 },
    engineering: { enabled: true, maxCommandRuntimeMs: 600000, allowHardwareMutationInWorkspace: true, allowSerialWriteInWorkspace: true }
  };
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-transfer-'));
  await fs.mkdir(path.join(root, 'source', 'project'), { recursive: true });
  await fs.mkdir(path.join(root, 'dest', 'project'), { recursive: true });
  const policy = new PolicyEngine(config(root));
  const paths = new PathGuard(policy);
  const integrity = new ArtifactIntegrityAdapter(policy, paths);
  const source = new ArtifactTransferAdapter(policy, paths, integrity, {
    bindAddress: '127.0.0.1',
    allowLoopbackForTests: true
  });
  const dest = new ArtifactTransferAdapter(policy, paths, integrity, {
    bindAddress: '127.0.0.1',
    allowLoopbackForTests: true
  });
  return { root, source, dest };
}

test('native artifact transfer streams bytes directly and atomically accepts the destination artifact', async () => {
  const f = await fixture();
  try {
    const body = ':020000040801F1\n'.repeat(4096) + ':00000001FF\n';
    const sourcePath = path.join(f.root, 'source', 'project', 'firmware.hex');
    await fs.writeFile(sourcePath, body, 'utf8');
    const expectedSha256 = createHash('sha256').update(body).digest('hex');
    const expectedSize = Buffer.byteLength(body);

    const offer = await f.dest.createReceiveOffer({
      workspace: 'dest',
      projectPath: 'project',
      artifactName: 'firmware.hex',
      expectedSha256,
      expectedSize,
      ttlMs: 60_000
    });
    assert.equal(offer.transport, 'tailscale-http');
    assert.match(offer.endpoint, /^http:\/\/127\.0\.0\.1:\d+\/artifact-transfer\//);
    assert.ok(offer.ticket.length >= 32);

    const receipt = await f.source.push({
      workspace: 'source',
      projectPath: 'project',
      artifact: 'firmware.hex',
      endpoint: offer.endpoint,
      ticket: offer.ticket,
      expectedSha256,
      expectedSize
    });
    assert.equal(receipt.source.sha256, expectedSha256);
    assert.equal(receipt.source.size, expectedSize);
    assert.equal(receipt.accepted.sha256, expectedSha256);
    assert.equal(receipt.accepted.size, expectedSize);
    assert.match(receipt.accepted.verifiedPath, /^\.rwmcp\/artifacts\/verified\//);

    const verifiedAbsolute = path.join(f.root, 'dest', 'project', ...receipt.accepted.verifiedPath.split('/'));
    assert.equal(await fs.readFile(verifiedAbsolute, 'utf8'), body);
    await assert.rejects(
      fs.access(path.join(f.root, 'dest', 'project', '.rwmcp', 'artifacts', 'incoming', `${offer.transferId}-firmware.hex`)),
      /ENOENT/
    );
  } finally {
    await f.source.closeAllForTests();
    await f.dest.closeAllForTests();
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('native artifact transfer rejects a wrong ticket without consuming the one-shot offer', async () => {
  const f = await fixture();
  try {
    const body = ':020000040801F1\n:00000001FF\n';
    await fs.writeFile(path.join(f.root, 'source', 'project', 'firmware.hex'), body, 'utf8');
    const expectedSha256 = createHash('sha256').update(body).digest('hex');
    const expectedSize = Buffer.byteLength(body);
    const offer = await f.dest.createReceiveOffer({
      workspace: 'dest',
      projectPath: 'project',
      artifactName: 'firmware.hex',
      expectedSha256,
      expectedSize,
      ttlMs: 60_000
    });

    await assert.rejects(
      f.source.push({
        workspace: 'source',
        projectPath: 'project',
        artifact: 'firmware.hex',
        endpoint: offer.endpoint,
        ticket: 'A'.repeat(43),
        expectedSha256,
        expectedSize
      }),
      /HTTP 401.*Invalid transfer ticket/
    );

    const receipt = await f.source.push({
      workspace: 'source',
      projectPath: 'project',
      artifact: 'firmware.hex',
      endpoint: offer.endpoint,
      ticket: offer.ticket,
      expectedSha256,
      expectedSize
    });
    assert.equal(receipt.accepted.sha256, expectedSha256);
  } finally {
    await f.source.closeAllForTests();
    await f.dest.closeAllForTests();
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('native artifact push fails before network I/O when source integrity differs from the offer', async () => {
  const f = await fixture();
  try {
    const body = ':00000001FF\n';
    await fs.writeFile(path.join(f.root, 'source', 'project', 'firmware.hex'), body, 'utf8');
    const actualSha = createHash('sha256').update(body).digest('hex');
    const expectedSize = Buffer.byteLength(body);
    const offer = await f.dest.createReceiveOffer({
      workspace: 'dest',
      projectPath: 'project',
      artifactName: 'firmware.hex',
      expectedSha256: actualSha,
      expectedSize,
      ttlMs: 60_000
    });

    await assert.rejects(
      f.source.push({
        workspace: 'source',
        projectPath: 'project',
        artifact: 'firmware.hex',
        endpoint: offer.endpoint,
        ticket: offer.ticket,
        expectedSha256: '0'.repeat(64),
        expectedSize
      }),
      /Source artifact SHA-256 mismatch/
    );

    const receipt = await f.source.push({
      workspace: 'source',
      projectPath: 'project',
      artifact: 'firmware.hex',
      endpoint: offer.endpoint,
      ticket: offer.ticket,
      expectedSha256: actualSha,
      expectedSize
    });
    assert.equal(receipt.accepted.sha256, actualSha);
  } finally {
    await f.source.closeAllForTests();
    await f.dest.closeAllForTests();
    await fs.rm(f.root, { recursive: true, force: true });
  }
});
