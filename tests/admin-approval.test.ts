import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  approveAdminRequest,
  createAdminRequest,
  denyAdminRequest,
  listAdminRequests,
  readAdminRequest
} from '../src/privileged/approval-store.js';
import { runAsPrincipal } from '../src/security/request-principal.js';

test('admin requests are client-bound records that require a separate local approval step', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-admin-approval-'));
  const previous = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = root;
  try {
    const request = await runAsPrincipal({
      id: 'openai-tunnel',
      type: 'openai-secure-mcp-tunnel',
      scopes: ['workstation.admin_request'],
      authenticated: true
    }, () => createAdminRequest({
      program: 'winget.exe',
      args: ['--version'],
      cwd: root,
      reason: 'Verify privileged approval flow'
    }));

    assert.equal(request.state, 'pending');
    assert.equal(request.clientId, 'openai-tunnel');
    assert.match(request.commandHash, /^[a-f0-9]{64}$/);
    assert.ok(Date.parse(request.expiresAt) > Date.parse(request.createdAt));

    const listed = await listAdminRequests();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.id, request.id);

    await assert.rejects(() => approveAdminRequest(request.id, '0'.repeat(64)), /changed after it was displayed/);
    const approved = await approveAdminRequest(request.id, request.commandHash);
    assert.equal(approved.request.state, 'approved');
    assert.match(approved.fileSha256, /^[a-f0-9]{64}$/);
    assert.equal((await readAdminRequest(request.id)).state, 'approved');
    await assert.rejects(() => approveAdminRequest(request.id, request.commandHash), /only pending requests/);
  } finally {
    if (previous === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('admin requests can be denied without executing anything', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-admin-deny-'));
  const previous = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = root;
  try {
    const request = await createAdminRequest({ program: 'whoami.exe', reason: 'Test deny flow' });
    const denied = await denyAdminRequest(request.id);
    assert.equal(denied.state, 'denied');
    assert.ok(denied.deniedAt);
    await assert.rejects(() => denyAdminRequest(request.id), /only pending requests/);
  } finally {
    if (previous === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});
