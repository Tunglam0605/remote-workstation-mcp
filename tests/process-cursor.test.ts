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

test('process manager returns incremental stdout/stderr with cursors', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-process-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const executable = path.basename(process.execPath);
  const config: PolicyConfig = {
    version: 1,
    mode: 'workspace',
    workspaces: [{ id: 'w', root }],
    filesystem: { maxReadBytes: 1024, maxWriteBytes: 1024 },
    process: { allowExecutables: [executable], inheritEnv: ['PATH'], maxOutputBytes: 1024, maxRuntimeMs: 5000 }
  };
  const policy = new PolicyEngine(config);
  const manager = new ProcessManager(policy, new PathGuard(policy));
  const started = await manager.start('w', process.execPath, ['-e', "process.stdout.write('abc');process.stderr.write('err')"]);

  for (let attempt = 0; attempt < 50 && manager.read(started.id).status === 'running'; attempt += 1) {
    await sleep(20);
  }

  const first = manager.readSince(started.id, 0, 0);
  assert.equal(first.stdout.text, 'abc');
  assert.equal(first.stderr.text, 'err');
  const second = manager.readSince(started.id, first.stdout.nextCursor, first.stderr.nextCursor);
  assert.equal(second.stdout.text, '');
  assert.equal(second.stderr.text, '');
});
