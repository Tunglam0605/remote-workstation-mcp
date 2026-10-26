import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProcessManager } from '../src/adapters/process-manager.js';
import type { PolicyConfig } from '../src/model.js';
import { PolicyEngine } from '../src/policy.js';
import { PathGuard } from '../src/security/path-guard.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('Windows ProcessManager executes owner-allowed npm with no shell and denies non-allowed npm', {
  skip: process.platform !== 'win32',
  timeout: 20_000
}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-windows-npm-process-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3 }));

  const config: PolicyConfig = {
    version: 1,
    mode: 'workspace',
    workspaces: [{ id: 'w', root }],
    filesystem: { maxReadBytes: 1024, maxWriteBytes: 1024 },
    process: {
      allowExecutables: ['npm'],
      inheritEnv: ['PATH'],
      maxOutputBytes: 4096,
      maxRuntimeMs: 10_000
    }
  };

  const deniedConfig: PolicyConfig = {
    ...config,
    process: { ...config.process, allowExecutables: ['node'] }
  };
  const deniedPolicy = new PolicyEngine(deniedConfig);
  const deniedManager = new ProcessManager(deniedPolicy, new PathGuard(deniedPolicy));
  await assert.rejects(deniedManager.start('w', 'npm', ['--version']), /process\.allowExecutables/);
  assert.deepEqual(deniedManager.list(), []);

  const policy = new PolicyEngine(config);
  const manager = new ProcessManager(policy, new PathGuard(policy));
  const started = await manager.start('w', 'npm', ['--version']);
  assert.equal(started.program, 'npm');
  assert.deepEqual(started.args, ['--version']);

  try {
    for (let attempt = 0; attempt < 100 && manager.read(started.id).status === 'running'; attempt += 1) {
      await sleep(75);
    }

    const finished = manager.read(started.id);
    assert.equal(finished.status, 'exited', finished.stderr);
    assert.equal(finished.exitCode, 0, finished.stderr);
    assert.match(finished.stdout.trim(), /^\d+\.\d+\.\d+$/);
    assert.equal(manager.activeCount(), 0);
  } finally {
    if (manager.read(started.id).status === 'running') await manager.stop(started.id);
  }
});
