import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { PolicyConfig } from '../src/model.js';
import { PolicyEngine } from '../src/policy.js';
import { PathGuard } from '../src/security/path-guard.js';
import { ProcessManager } from '../src/adapters/process-manager.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function removeEventually(target: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    try {
      await fs.rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EBUSY' && code !== 'EPERM') throw error;
      await sleep(100);
    }
  }
  throw lastError;
}

test('managed process stdin is bounded and private to the creating principal', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-process-input-'));
  t.after(async () => removeEventually(root));
  const executable = path.basename(process.execPath);
  const config: PolicyConfig = {
    version: 1,
    mode: 'workspace',
    workspaces: [{ id: 'w', root }],
    filesystem: { maxReadBytes: 1024, maxWriteBytes: 1024 },
    process: {
      allowExecutables: [executable],
      inheritEnv: ['PATH', 'SystemRoot', 'WINDIR'],
      maxOutputBytes: 4096,
      maxRuntimeMs: 5000,
      maxInputBytes: 16
    }
  };

  let owner = 'principal-a';
  const policy = new PolicyEngine(config);
  const manager = new ProcessManager(policy, new PathGuard(policy), () => owner);
  const started = await manager.start('w', process.execPath, [
    '-e',
    "process.stdin.setEncoding('utf8');process.stdin.on('data',d=>process.stdout.write('echo:'+d));process.stdin.on('end',()=>process.exit(0));"
  ]);

  assert.equal(started.stdinOpen, true);
  assert.throws(() => manager.write(started.id, '0123456789abcdefg'), /maxInputBytes/);

  const write = manager.write(started.id, 'hello', true);
  assert.equal(write.acceptedBytes, 6);
  assert.equal(write.stdinOpen, true);

  owner = 'principal-b';
  assert.throws(() => manager.write(started.id, 'intrude'), /Unknown process id/);
  assert.throws(() => manager.closeStdin(started.id), /Unknown process id/);

  owner = 'principal-a';
  let output = '';
  for (let attempt = 0; attempt < 100; attempt += 1) {
    output = manager.read(started.id).stdout;
    if (output.includes('echo:hello')) break;
    await sleep(20);
  }
  assert.match(output, /echo:hello/);

  const closing = manager.closeStdin(started.id);
  assert.equal(closing.stdinOpen, false);

  for (let attempt = 0; attempt < 100 && manager.read(started.id).status === 'running'; attempt += 1) {
    await sleep(20);
  }
  assert.equal(manager.read(started.id).status, 'exited');
  assert.throws(() => manager.write(started.id, 'late'), /not running/);
});
