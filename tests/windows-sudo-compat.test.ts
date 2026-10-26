import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createAdminRequest, readAdminRequest } from '../src/privileged/approval-store.js';
import { normalizeWindowsSudoRequest } from '../src/privileged/windows-sudo-compat.js';
import { runAsPrincipal } from '../src/security/request-principal.js';

test('Windows sudo shorthand resolves into a direct executable without spawning sudo', () => {
  const converted = normalizeWindowsSudoRequest({
    program: 'sudo.exe', args: ['winget.exe', '--version'], cwd: 'C:\\Users\\Admin'
  }, 'win32');
  assert.equal(converted.program, 'winget.exe');
  assert.deepEqual(converted.args, ['--version']);
  assert.equal(converted.cwd, 'C:\\Users\\Admin');
  assert.equal(converted.authorization, 'owner-approved-runas-uac');
  assert.equal(converted.sudoCompatibility, true);
});

test('sudo -- and case-insensitive spelling preserve argv exactly', () => {
  const converted = normalizeWindowsSudoRequest({
    program: 'SUDO', args: ['--', 'dism.exe', '/Online', '/Get-Features']
  }, 'win32');
  assert.equal(converted.program, 'dism.exe');
  assert.deepEqual(converted.args, ['/Online', '/Get-Features']);
});

test('reject empty targets, flags, nested elevation, interpreters and scripts', () => {
  for (const args of [
    [], ['--'], ['-E', 'winget.exe'], ['--inline', 'winget.exe'],
    ['sudo.exe', 'winget.exe'], ['cmd.exe', '/c', 'whoami'],
    ['powershell.exe', '-Command', 'whoami'], ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'],
    ['script.ps1'], ['installer.cmd'], ['script.bat']
  ]) {
    assert.throws(
      () => normalizeWindowsSudoRequest({ program: 'sudo', args }, 'win32'),
      /WINDOWS_SUDO_|direct executable/
    );
  }
});

test('existing native admin_request commands and Linux commands stay unchanged', () => {
  const standard = normalizeWindowsSudoRequest({ program: 'winget.exe', args: ['list'] }, 'win32');
  assert.deepEqual(standard.args, ['list']);
  assert.equal(standard.sudoCompatibility, false);
  const linux = normalizeWindowsSudoRequest({ program: 'sudo', args: ['apt', 'install', '-y', 'curl'] }, 'linux');
  assert.equal(linux.program, 'sudo');
  assert.deepEqual(linux.args, ['apt', 'install', '-y', 'curl']);
  assert.equal(linux.sudoCompatibility, false);
});

test('Windows sudo request becomes client-bound approval-only record, not execution', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-sudo-compat-'));
  const before = process.env.RWMCP_ADMIN_APPROVAL_DIR;
  process.env.RWMCP_ADMIN_APPROVAL_DIR = root;
  try {
    const command = normalizeWindowsSudoRequest({
      program: 'sudo.exe', args: ['whoami.exe', '/groups'], cwd: root
    }, 'win32');
    const created = await runAsPrincipal({
      id: 'openai-tunnel', type: 'openai-secure-mcp-tunnel',
      scopes: ['workstation.admin_request'], authenticated: true
    }, () => createAdminRequest({ program: command.program, args: command.args, cwd: command.cwd, reason: 'Diagnostic only' }));
    assert.equal(created.program, 'whoami.exe');
    assert.deepEqual(created.args, ['/groups']);
    assert.equal(created.clientId, 'openai-tunnel');
    assert.equal(created.state, 'pending');
    assert.equal((await readAdminRequest(created.id)).state, 'pending');
    assert.match(created.commandHash, /^[a-f0-9]{64}$/);
  } finally {
    if (before === undefined) delete process.env.RWMCP_ADMIN_APPROVAL_DIR;
    else process.env.RWMCP_ADMIN_APPROVAL_DIR = before;
    await fs.rm(root, { recursive: true, force: true });
  }
});
