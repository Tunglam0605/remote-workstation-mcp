import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  approveLinuxHostRebootRequest,
  isLinuxHostRebootRequest,
  linuxHostRebootCommand
} from '../src/tui/admin-requests.js';
import { createAdminRequest, readAdminRequest } from '../src/privileged/approval-store.js';
import { setupConfigDir } from '../src/setup/settings.js';

async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-tui-admin-'));
  const approvalDir = path.join(root, 'approvals');
  const previous = process.env.RWMCP_ADMIN_APPROVAL_DIR;
  process.env.RWMCP_ADMIN_APPROVAL_DIR = approvalDir;
  t.after(async () => {
    if (previous === undefined) delete process.env.RWMCP_ADMIN_APPROVAL_DIR;
    else process.env.RWMCP_ADMIN_APPROVAL_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    root,
    options: {
      platform: 'linux' as NodeJS.Platform,
      homeDir: root,
      env: { XDG_CONFIG_HOME: path.join(root, 'config') } as NodeJS.ProcessEnv
    }
  };
}

test('typed Linux host reboot approval executes only fixed sudo/systemctl argv and records success', async t => {
  const fx = await fixture(t);
  const command = linuxHostRebootCommand();
  const request = await createAdminRequest({
    program: command.program,
    args: command.args,
    reason: 'Reload the NVIDIA kernel module after package update'
  });
  assert.equal(isLinuxHostRebootRequest(request), true);

  const calls: Array<{ program: string; args: string[] }> = [];
  const finished = await approveLinuxHostRebootRequest(request.id, request.commandHash, {
    ...fx.options,
    runPrivileged: async (program, args) => {
      calls.push({ program, args });
      return { code: 0, stdout: '', stderr: '' };
    }
  });

  assert.deepEqual(calls, [{
    program: 'sudo',
    args: ['-k', '--', '/usr/bin/systemctl', '--no-block', 'reboot']
  }]);
  assert.equal(finished.state, 'succeeded');
  assert.equal(finished.result?.exitCode, 0);
  assert.equal((await readAdminRequest(request.id)).state, 'succeeded');
});

test('Ubuntu TUI refuses arbitrary Linux admin requests instead of becoming a generic root shell', async t => {
  const fx = await fixture(t);
  const request = await createAdminRequest({
    program: '/usr/bin/apt',
    args: ['update'],
    reason: 'Must not be approved by the typed reboot path'
  });
  assert.equal(isLinuxHostRebootRequest(request), false);

  await assert.rejects(
    approveLinuxHostRebootRequest(request.id, request.commandHash, {
      ...fx.options,
      runPrivileged: async () => ({ code: 0, stdout: '', stderr: '' })
    }),
    /restricted to the typed host reboot request/
  );
  assert.equal((await readAdminRequest(request.id)).state, 'pending');
});

test('active Work Session interlock blocks host reboot before approval is consumed', async t => {
  const fx = await fixture(t);
  const command = linuxHostRebootCommand();
  const request = await createAdminRequest({
    program: command.program,
    args: command.args,
    reason: 'Reboot should wait until active engineering work completes'
  });

  const interlockFile = path.join(
    setupConfigDir(fx.options),
    'runtime',
    'work-session-interlocks.json'
  );
  await fs.mkdir(path.dirname(interlockFile), { recursive: true });
  await fs.writeFile(interlockFile, JSON.stringify({
    version: 1,
    records: [{
      version: 1,
      id: 'interlock-test',
      pid: process.pid,
      principalId: 'owner',
      workSessionId: 'session-active',
      kind: 'workflow',
      label: 'firmware.flash',
      acquiredAt: new Date().toISOString()
    }]
  }), 'utf8');

  await assert.rejects(
    approveLinuxHostRebootRequest(request.id, request.commandHash, {
      ...fx.options,
      runPrivileged: async () => ({ code: 0, stdout: '', stderr: '' })
    }),
    /NODE_BUSY/
  );
  assert.equal((await readAdminRequest(request.id)).state, 'pending');
});
