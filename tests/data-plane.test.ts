import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
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

function directAuthorization(fileName: string, size: number, digest: string) {
  return {
    grantId: 'test-direct',
    sourceNodeId: 'dev_source',
    destinationNodeId: 'dev_dest',
    sourceWorkspace: 'source',
    destinationWorkspace: 'dest',
    sourcePath: `project/${fileName}`,
    destinationBasePath: 'project',
    destinationFileName: fileName,
    size,
    sha256: digest,
    transport: 'direct' as const
  };
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-data-plane-'));
  await fs.mkdir(path.join(root, 'source', 'project'), { recursive: true });
  await fs.mkdir(path.join(root, 'dest', 'project'), { recursive: true });
  const policy = new PolicyEngine(config(root));
  const paths = new PathGuard(policy);
  const source = new DataPlaneAdapter(policy, paths, { bindAddress: '127.0.0.1', allowLoopbackForTests: true });
  const dest = new DataPlaneAdapter(policy, paths, { bindAddress: '127.0.0.1', allowLoopbackForTests: true });
  return { root, source, dest };
}

test('generic data plane transfers a non-firmware file while engineering tools are disabled', async () => {
  const f = await fixture();
  try {
    const body = JSON.stringify({ report: 'platform', values: [1, 2, 3] }) + '\n';
    const sourcePath = path.join(f.root, 'source', 'project', 'report.json');
    await fs.writeFile(sourcePath, body, 'utf8');
    const expectedSha256 = createHash('sha256').update(body).digest('hex');
    const expectedSize = Buffer.byteLength(body);

    const prepared = await f.source.prepare('source', 'project', 'report.json');
    assert.equal(prepared.sha256, expectedSha256);
    assert.equal(prepared.size, expectedSize);

    const offer = await f.dest.createReceiveOffer({
      workspace: 'dest',
      basePath: 'project',
      fileName: 'report.json',
      expectedSha256,
      expectedSize,
      ttlMs: 60_000,
      authorization: directAuthorization('report.json', expectedSize, expectedSha256)
    });

    const before = f.dest.status();
    assert.equal(before.activeOffers.length, 1);
    assert.equal(before.activeOffers[0]?.fileName, 'report.json');
    assert.equal(JSON.stringify(before).includes(offer.ticket), false);

    const receipt = await f.source.push({
      workspace: 'source',
      basePath: 'project',
      file: 'report.json',
      endpoint: offer.endpoint,
      ticket: offer.ticket,
      expectedSha256,
      expectedSize,
      authorization: directAuthorization('report.json', expectedSize, expectedSha256)
    });

    assert.equal(receipt.accepted.sha256, expectedSha256);
    assert.equal(receipt.accepted.size, expectedSize);
    assert.match(receipt.accepted.verifiedPath, /^\.rwmcp\/transfers\/verified\//);
    const verified = path.join(f.root, 'dest', 'project', ...receipt.accepted.verifiedPath.split('/'));
    assert.equal(await fs.readFile(verified, 'utf8'), body);

    await new Promise(resolve => setTimeout(resolve, 20));
    const after = f.dest.status();
    assert.equal(after.activeOffers.length, 0);
    assert.equal(after.recentTransfers[0]?.status, 'succeeded');
    assert.equal(after.recentTransfers[0]?.direction, 'receive');
    assert.equal(JSON.stringify(after).includes(offer.ticket), false);
  } finally {
    await f.source.closeAllForTests();
    await f.dest.closeAllForTests();
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('generic data plane rejects a wrong ticket without consuming the valid one-shot offer', async () => {
  const f = await fixture();
  try {
    const body = 'hello direct nodes\n';
    await fs.writeFile(path.join(f.root, 'source', 'project', 'notes.txt'), body, 'utf8');
    const expectedSha256 = createHash('sha256').update(body).digest('hex');
    const expectedSize = Buffer.byteLength(body);
    const offer = await f.dest.createReceiveOffer({
      workspace: 'dest',
      basePath: 'project',
      fileName: 'notes.txt',
      expectedSha256,
      expectedSize,
      ttlMs: 60_000,
      authorization: directAuthorization('notes.txt', expectedSize, expectedSha256)
    });

    await assert.rejects(
      f.source.push({
        workspace: 'source',
        basePath: 'project',
        file: 'notes.txt',
        endpoint: offer.endpoint,
        ticket: 'A'.repeat(43),
        expectedSha256,
        expectedSize,
        authorization: directAuthorization('notes.txt', expectedSize, expectedSha256)
      }),
      /HTTP 401.*Invalid transfer ticket/
    );

    assert.equal(f.dest.status().activeOffers.length, 1);
    const receipt = await f.source.push({
      workspace: 'source',
      basePath: 'project',
      file: 'notes.txt',
      endpoint: offer.endpoint,
      ticket: offer.ticket,
      expectedSha256,
      expectedSize,
      authorization: directAuthorization('notes.txt', expectedSize, expectedSha256)
    });
    assert.equal(receipt.accepted.sha256, expectedSha256);
  } finally {
    await f.source.closeAllForTests();
    await f.dest.closeAllForTests();
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('generic data plane remains workspace-contained and fails before network on source integrity mismatch', async () => {
  const f = await fixture();
  try {
    const body = 'bounded\n';
    await fs.writeFile(path.join(f.root, 'source', 'project', 'data.log'), body, 'utf8');
    const actualSha256 = createHash('sha256').update(body).digest('hex');
    const expectedSize = Buffer.byteLength(body);

    await assert.rejects(
      f.source.prepare('source', 'project', '../escape.log'),
      /must not escape/
    );

    const offer = await f.dest.createReceiveOffer({
      workspace: 'dest',
      basePath: 'project',
      fileName: 'data.log',
      expectedSha256: actualSha256,
      expectedSize,
      ttlMs: 60_000,
      authorization: directAuthorization('data.log', expectedSize, actualSha256)
    });

    await assert.rejects(
      f.source.push({
        workspace: 'source',
        basePath: 'project',
        file: 'data.log',
        endpoint: offer.endpoint,
        ticket: offer.ticket,
        expectedSha256: '0'.repeat(64),
        expectedSize,
        authorization: directAuthorization('data.log', expectedSize, '0'.repeat(64))
      }),
      /Source file SHA-256 mismatch/
    );
    assert.equal(f.dest.status().activeOffers.length, 1);
  } finally {
    await f.source.closeAllForTests();
    await f.dest.closeAllForTests();
    await fs.rm(f.root, { recursive: true, force: true });
  }
});


test('generic data plane falls back across direct endpoints without exposing the ticket', async () => {
  const f = await fixture();
  try {
    const body = 'multi-endpoint fallback\n';
    await fs.writeFile(path.join(f.root, 'source', 'project', 'fallback.txt'), body, 'utf8');
    const expectedSha256 = createHash('sha256').update(body).digest('hex');
    const expectedSize = Buffer.byteLength(body);
    const offer = await f.dest.createReceiveOffer({
      workspace: 'dest',
      basePath: 'project',
      fileName: 'fallback.txt',
      expectedSha256,
      expectedSize,
      ttlMs: 60_000,
      authorization: directAuthorization('fallback.txt', expectedSize, expectedSha256)
    });

    assert.equal(offer.transport, 'direct-http');
    assert.ok(offer.endpoints.length >= 1);
    assert.equal(JSON.stringify(offer.endpoints).includes(offer.ticket), false);

    const receipt = await f.source.push({
      workspace: 'source',
      basePath: 'project',
      file: 'fallback.txt',
      endpoints: [
        'http://127.0.0.1:1/rwmcp-data/unreachable-test',
        ...offer.endpoints.map(item => item.endpoint)
      ],
      ticket: offer.ticket,
      expectedSha256,
      expectedSize,
      timeoutMs: 10_000,
      authorization: directAuthorization('fallback.txt', expectedSize, expectedSha256)
    });

    assert.equal(receipt.accepted.sha256, expectedSha256);
    assert.equal(receipt.transport, 'loopback-test');
  } finally {
    await f.source.closeAllForTests();
    await f.dest.closeAllForTests();
    await fs.rm(f.root, { recursive: true, force: true });
  }
});


test('direct transfer ticket is bound to the authorized node/workspace/file contract', async () => {
  const f = await fixture();
  try {
    const body = 'binding-check\n';
    await fs.writeFile(path.join(f.root, 'source', 'project', 'binding.txt'), body, 'utf8');
    const expectedSha256 = createHash('sha256').update(body).digest('hex');
    const expectedSize = Buffer.byteLength(body);
    const authorization = directAuthorization('binding.txt', expectedSize, expectedSha256);

    const offer = await f.dest.createReceiveOffer({
      workspace: 'dest',
      basePath: 'project',
      fileName: 'binding.txt',
      expectedSha256,
      expectedSize,
      ttlMs: 60_000,
      authorization
    });

    await assert.rejects(
      f.source.push({
        workspace: 'source',
        basePath: 'project',
        file: 'binding.txt',
        endpoint: offer.endpoint,
        ticket: offer.ticket,
        expectedSha256,
        expectedSize,
        authorization: { ...authorization, destinationNodeId: 'dev_other' }
      }),
      /HTTP 403.*authorization binding/i
    );

    assert.equal(f.dest.status().activeOffers.length, 1);
    const receipt = await f.source.push({
      workspace: 'source',
      basePath: 'project',
      file: 'binding.txt',
      endpoint: offer.endpoint,
      ticket: offer.ticket,
      expectedSha256,
      expectedSize,
      authorization
    });
    assert.equal(receipt.accepted.sha256, expectedSha256);
  } finally {
    await f.source.closeAllForTests();
    await f.dest.closeAllForTests();
    await fs.rm(f.root, { recursive: true, force: true });
  }
});
