import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  adminRequestPath,
  approveAdminRequest,
  createAdminRequest,
  finishAdminRequest,
  markAdminRequestRunning,
  readAdminRequest
} from '../src/privileged/approval-store.js';

async function forceDeadlineToPast(id: string): Promise<void> {
  const file = adminRequestPath(id);
  const request = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
  request.expiresAt = new Date(Date.now() - 60_000).toISOString();
  await fs.writeFile(file, JSON.stringify(request, null, 2) + '\n', 'utf8');
}

test('stale approved Administrator requests expire without executing and cannot start late', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-admin-approved-expiry-'));
  const previous = process.env.RWMCP_ADMIN_APPROVAL_DIR;
  process.env.RWMCP_ADMIN_APPROVAL_DIR = root;
  try {
    const request = await createAdminRequest({
      program: 'whoami.exe',
      reason: 'Regression: owner-approved but elevated helper never started'
    });
    const approved = await approveAdminRequest(request.id, request.commandHash);
    assert.equal(approved.request.state, 'approved');
    await forceDeadlineToPast(request.id);
    const observed = await readAdminRequest(request.id);
    assert.equal(observed.state, 'expired');
    assert.ok(observed.approvedAt);
    assert.equal(observed.startedAt, undefined);
    assert.equal(observed.result, undefined);
    await assert.rejects(
      () => markAdminRequestRunning(request.id),
      /only approved requests can start/
    );
    assert.equal((await readAdminRequest(request.id)).state, 'expired');
  } finally {
    if (previous === undefined) delete process.env.RWMCP_ADMIN_APPROVAL_DIR;
    else process.env.RWMCP_ADMIN_APPROVAL_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('approved request already running survives original approval TTL until completion', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-admin-running-deadline-'));
  const previous = process.env.RWMCP_ADMIN_APPROVAL_DIR;
  process.env.RWMCP_ADMIN_APPROVAL_DIR = root;
  try {
    const request = await createAdminRequest({program: 'whoami.exe', reason: 'Running request semantics'});
    await approveAdminRequest(request.id, request.commandHash);
    await markAdminRequestRunning(request.id);
    await forceDeadlineToPast(request.id);
    assert.equal((await readAdminRequest(request.id)).state, 'running');
    const completed = await finishAdminRequest(request.id, { exitCode: 0, output: 'ok' });
    assert.equal(completed.state, 'succeeded');
    assert.equal((await readAdminRequest(request.id)).state, 'succeeded');
  } finally {
    if (previous === undefined) delete process.env.RWMCP_ADMIN_APPROVAL_DIR;
    else process.env.RWMCP_ADMIN_APPROVAL_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('unapproved requests keep their existing pending-expiry behavior', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-admin-pending-expiry-'));
  const previous = process.env.RWMCP_ADMIN_APPROVAL_DIR;
  process.env.RWMCP_ADMIN_APPROVAL_DIR = root;
  try {
    const request = await createAdminRequest({program: 'whoami.exe', reason: 'Pending expiry'});
    await forceDeadlineToPast(request.id);
    assert.equal((await readAdminRequest(request.id)).state, 'expired');
    await assert.rejects(
      () => approveAdminRequest(request.id, request.commandHash),
      /only pending requests can be approved/
    );
  } finally {
    if (previous === undefined) delete process.env.RWMCP_ADMIN_APPROVAL_DIR;
    else process.env.RWMCP_ADMIN_APPROVAL_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});
