import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TerminalManager } from '../src/adapters/engineering/terminal-manager.js';
import type { PolicyConfig } from '../src/model.js';
import { PolicyEngine } from '../src/policy.js';
import { PathGuard } from '../src/security/path-guard.js';

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for terminal output.');
}

test('terminal manager provides a real PTY/ConPTY with bounded caller-owned output', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-pty-'));
  try {
    const config: PolicyConfig = {
      version: 1, mode: 'workspace', workspaces: [{ id: 'w', root, readOnly: false }],
      filesystem: { maxReadBytes: 1024 * 1024, maxWriteBytes: 1024 * 1024 },
      process: { allowExecutables: [process.execPath], inheritEnv: ['PATH', 'HOME', 'TEMP', 'TMP'], maxOutputBytes: 65536, maxRuntimeMs: 60000, maxInputBytes: 65536 }
    };
    const policy = new PolicyEngine(config);
    const terminal = new TerminalManager(policy, new PathGuard(policy), 'owner');
    const session = await terminal.start('w', process.execPath, ['-e', "console.log('PTY_CONTRACT_OK')"], '.');
    await waitFor(() => terminal.read(session.id).text.includes('PTY_CONTRACT_OK'));
    const read = terminal.read(session.id);
    assert.match(read.text, /PTY_CONTRACT_OK/);
    assert.ok(read.nextCursor > 0);
    await terminal.stop(session.id);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('terminal stop does not leak ConPTY helpers or emit AttachConsole failures', () => {
  const child = spawnSync(process.execPath, ['--import', 'tsx', path.join('tests', 'fixtures', 'pty-stop-race.ts')], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 8000,
    windowsHide: true
  });
  assert.notEqual(child.error?.name, 'ETIMEDOUT', `child timed out: ${child.stderr}`);
  assert.equal(child.status, 0, `stderr: ${child.stderr}`);
  assert.doesNotMatch(child.stderr, /AttachConsole failed/);
});


test('natural ConPTY exit releases native handles without an explicit stop call', () => {
  const child = spawnSync(process.execPath, ['--import', 'tsx', path.join('tests', 'fixtures', 'pty-natural-exit.ts')], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true
  });
  if (process.platform === 'win32') {
    assert.notEqual(child.error?.name, 'ETIMEDOUT', `child timed out: ${child.stderr}`);
    assert.equal(child.status, 0, `stderr: ${child.stderr}`);
    assert.doesNotMatch(child.stderr, /AttachConsole failed/);
  }
});
