import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ControlPlaneRelayAdapter } from '../src/adapters/control-plane-relay.js';
import { DataPlaneAdapter } from '../src/adapters/data-plane.js';
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
    engineering: { enabled: false, maxCommandRuntimeMs: 600000, allowHardwareMutationInWorkspace: false, allowSerialWriteInWorkspace: false }
  };
}

async function fixture(now?: () => number) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-control-relay-'));
  await fs.mkdir(path.join(root, 'source', 'project'), { recursive: true });
  await fs.mkdir(path.join(root, 'dest', 'project'), { recursive: true });
  const policy = new PolicyEngine(config(root));
  const paths = new PathGuard(policy);
  const dataPlane = new DataPlaneAdapter(policy, paths, { bindAddress: '127.0.0.1', allowLoopbackForTests: true, ...(now ? { now } : {}) });
  const source = new ControlPlaneRelayAdapter(policy, paths, dataPlane, { ...(now ? { now } : {}) });
  const dest = new ControlPlaneRelayAdapter(policy, paths, dataPlane, { ...(now ? { now } : {}) });
  return { root, policy, paths, dataPlane, source, dest };
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function relayAuthorization(fileName: string, size: number, digest: string) {
  return {
    grantId: 'test-relay',
    sourceNodeId: 'dev_source',
    destinationNodeId: 'dev_dest',
    sourceWorkspace: 'source',
    destinationWorkspace: 'dest',
    sourcePath: `project/${fileName}`,
    destinationBasePath: 'project',
    destinationFileName: fileName,
    size,
    sha256: digest,
    transport: 'relay' as const
  };
}

test('control-plane relay transfers binary data and resumes from persistent session state', async () => {
  const f = await fixture();
  try {
    const body = Buffer.allocUnsafe(150_321);
    for (let i = 0; i < body.length; i += 1) body[i] = (i * 31 + 7) & 0xff;
    const expectedSha256 = sha256(body);
    await fs.writeFile(path.join(f.root, 'source', 'project', 'evidence.bin'), body);

    const session = await f.dest.begin({
      workspace: 'dest',
      basePath: 'project',
      fileName: 'evidence.bin',
      expectedSha256,
      expectedSize: body.length,
      authorization: relayAuthorization('evidence.bin', body.length, expectedSha256)
    });

    const first = await f.source.readChunk({
      workspace: 'source',
      basePath: 'project',
      file: 'evidence.bin',
      offset: 0,
      chunkBytes: 64 * 1024
    });
    assert.equal(first.length, 64 * 1024);
    assert.equal(first.sha256, sha256(Buffer.from(first.dataBase64, 'base64')));

    const firstWrite = await f.dest.writeChunk({
      workspace: 'dest',
      basePath: 'project',
      sessionId: session.sessionId,
      offset: first.offset,
      dataBase64: first.dataBase64,
      chunkSha256: first.sha256
    });
    assert.equal(firstWrite.nextOffset, first.nextOffset);

    const restartedDest = new ControlPlaneRelayAdapter(f.policy, f.paths, f.dataPlane);
    const resumed = await restartedDest.sessionStatus({
      workspace: 'dest',
      basePath: 'project',
      sessionId: session.sessionId
    });
    assert.equal(resumed.nextOffset, first.nextOffset);

    let offset = resumed.nextOffset;
    while (offset < body.length) {
      const chunk = await f.source.readChunk({
        workspace: 'source',
        basePath: 'project',
        file: 'evidence.bin',
        offset,
        chunkBytes: 64 * 1024
      });
      const written = await restartedDest.writeChunk({
        workspace: 'dest',
        basePath: 'project',
        sessionId: session.sessionId,
        offset,
        dataBase64: chunk.dataBase64,
        chunkSha256: chunk.sha256
      });
      assert.equal(written.nextOffset, chunk.nextOffset);
      offset = written.nextOffset;
    }

    const finalized = await restartedDest.finalize({
      workspace: 'dest',
      basePath: 'project',
      sessionId: session.sessionId
    });
    assert.equal(finalized.accepted.sha256, expectedSha256);
    assert.equal(finalized.accepted.size, body.length);
    assert.match(finalized.accepted.verifiedPath, /^\.rwmcp\/transfers\/verified\//);

    const verified = path.join(f.root, 'dest', 'project', ...finalized.accepted.verifiedPath.split('/'));
    assert.deepEqual(await fs.readFile(verified), body);

    await assert.rejects(
      restartedDest.sessionStatus({ workspace: 'dest', basePath: 'project', sessionId: session.sessionId }),
      /does not exist/
    );
  } finally {
    await f.dataPlane.closeAllForTests();
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('control-plane relay rejects wrong chunk hash and wrong offset without advancing state', async () => {
  const f = await fixture();
  try {
    const body = Buffer.from('bounded relay payload\n', 'utf8');
    await fs.writeFile(path.join(f.root, 'source', 'project', 'payload.txt'), body);
    const session = await f.dest.begin({
      workspace: 'dest',
      basePath: 'project',
      fileName: 'payload.txt',
      expectedSha256: sha256(body),
      expectedSize: body.length,
      authorization: relayAuthorization('payload.txt', body.length, sha256(body))
    });
    const chunk = await f.source.readChunk({
      workspace: 'source',
      basePath: 'project',
      file: 'payload.txt',
      offset: 0,
      chunkBytes: 64 * 1024
    });

    await assert.rejects(
      f.dest.writeChunk({
        workspace: 'dest',
        basePath: 'project',
        sessionId: session.sessionId,
        offset: 0,
        dataBase64: chunk.dataBase64,
        chunkSha256: '0'.repeat(64)
      }),
      /chunk SHA-256 mismatch/
    );
    assert.equal((await f.dest.sessionStatus({ workspace: 'dest', basePath: 'project', sessionId: session.sessionId })).nextOffset, 0);

    await assert.rejects(
      f.dest.writeChunk({
        workspace: 'dest',
        basePath: 'project',
        sessionId: session.sessionId,
        offset: 1,
        dataBase64: chunk.dataBase64,
        chunkSha256: chunk.sha256
      }),
      /offset mismatch/
    );
    assert.equal((await f.dest.sessionStatus({ workspace: 'dest', basePath: 'project', sessionId: session.sessionId })).nextOffset, 0);
  } finally {
    await f.dataPlane.closeAllForTests();
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('control-plane relay full-file mismatch fails closed and remains abortable', async () => {
  const f = await fixture();
  try {
    const body = Buffer.from('content with intentionally wrong final contract\n', 'utf8');
    await fs.writeFile(path.join(f.root, 'source', 'project', 'wrong.bin'), body);
    const session = await f.dest.begin({
      workspace: 'dest',
      basePath: 'project',
      fileName: 'wrong.bin',
      expectedSha256: '0'.repeat(64),
      expectedSize: body.length,
      authorization: relayAuthorization('wrong.bin', body.length, '0'.repeat(64))
    });
    const chunk = await f.source.readChunk({
      workspace: 'source',
      basePath: 'project',
      file: 'wrong.bin',
      offset: 0
    });
    await f.dest.writeChunk({
      workspace: 'dest',
      basePath: 'project',
      sessionId: session.sessionId,
      offset: 0,
      dataBase64: chunk.dataBase64,
      chunkSha256: chunk.sha256
    });

    await assert.rejects(
      f.dest.finalize({ workspace: 'dest', basePath: 'project', sessionId: session.sessionId }),
      /file SHA-256 mismatch/
    );
    assert.equal((await f.dest.sessionStatus({ workspace: 'dest', basePath: 'project', sessionId: session.sessionId })).nextOffset, body.length);

    const aborted = await f.dest.abort({ workspace: 'dest', basePath: 'project', sessionId: session.sessionId });
    assert.equal(aborted.removed, true);
  } finally {
    await f.dataPlane.closeAllForTests();
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('expired relay session is removed when accessed', async () => {
  let nowMs = Date.parse('2026-09-19T00:00:00Z');
  const f = await fixture(() => nowMs);
  try {
    const body = Buffer.from('expiry\n', 'utf8');
    await fs.writeFile(path.join(f.root, 'source', 'project', 'expiry.txt'), body);
    const session = await f.dest.begin({
      workspace: 'dest',
      basePath: 'project',
      fileName: 'expiry.txt',
      expectedSha256: sha256(body),
      expectedSize: body.length,
      ttlMs: 60_000,
      authorization: relayAuthorization('expiry.txt', body.length, sha256(body))
    });
    nowMs += 60_001;
    await assert.rejects(
      f.dest.sessionStatus({ workspace: 'dest', basePath: 'project', sessionId: session.sessionId }),
      /expired/
    );
    const relayRoot = path.join(f.root, 'dest', 'project', '.rwmcp', 'transfers', 'relay', session.sessionId);
    await assert.rejects(fs.access(relayRoot));
  } finally {
    await f.dataPlane.closeAllForTests();
    await fs.rm(f.root, { recursive: true, force: true });
  }
});
