import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BuildDiagnosticsAdapter } from '../src/adapters/build-diagnostics.js';
import { ProcessManager } from '../src/adapters/process-manager.js';
import type { PolicyConfig } from '../src/model.js';
import { PolicyEngine } from '../src/policy.js';
import { PathGuard } from '../src/security/path-guard.js';
import { runWithWorkSession } from '../src/security/execution-context.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const cleanup = (root: string) => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });

test('managed process ids and output are private to the creating principal', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-process-owner-'));
  t.after(async () => cleanup(root));
  const executable = path.basename(process.execPath);
  const config: PolicyConfig = {
    version: 1,
    mode: 'workspace',
    workspaces: [{ id: 'w', root }],
    filesystem: { maxReadBytes: 1024, maxWriteBytes: 1024 },
    process: { allowExecutables: [executable], inheritEnv: ['PATH'], maxOutputBytes: 4096, maxRuntimeMs: 5000 }
  };

  let currentOwner = 'principal-a';
  const policy = new PolicyEngine(config);
  const manager = new ProcessManager(policy, new PathGuard(policy), () => currentOwner);
  const diagnostics = new BuildDiagnosticsAdapter(manager);
  const started = await manager.start('w', process.execPath, ['-e', "process.stderr.write('main.c:2:3: error: boom\\n');setTimeout(()=>{}, 2000)"]);

  assert.equal(manager.list().length, 1);
  assert.equal(manager.read(started.id).id, started.id);

  currentOwner = 'principal-b';
  assert.deepEqual(manager.list(), []);
  assert.throws(() => manager.read(started.id), /Unknown process id/);
  assert.throws(() => manager.readSince(started.id), /Unknown process id/);
  await assert.rejects(manager.stop(started.id), /Unknown process id/);
  assert.throws(() => diagnostics.report(started.id), /Unknown process id/);

  currentOwner = 'principal-a';
  assert.equal(manager.read(started.id).id, started.id);
  await manager.stop(started.id);
  await sleep(100);
});

test('legacy/local process manager behavior remains shared under its fallback owner id', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-process-local-'));
  t.after(async () => cleanup(root));
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
  const started = await manager.start('w', process.execPath, ['-e', 'process.exit(0)']);
  assert.equal(manager.list().some(item => item.id === started.id), true);

  for (let attempt = 0; attempt < 50 && manager.read(started.id).status === 'running'; attempt += 1) {
    await sleep(20);
  }
  assert.notEqual(manager.read(started.id).status, 'running');
});


test('same principal cannot read or stop a process owned by another Work Session', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-process-work-session-'));
  t.after(async () => cleanup(root));
  const executable = path.basename(process.execPath);
  const config: PolicyConfig = {
    version: 1,
    mode: 'workspace',
    workspaces: [{ id: 'w', root }],
    filesystem: { maxReadBytes: 1024, maxWriteBytes: 1024 },
    process: { allowExecutables: [executable], inheritEnv: ['PATH'], maxOutputBytes: 4096, maxRuntimeMs: 5000 }
  };
  const policy = new PolicyEngine(config);
  const manager = new ProcessManager(policy, new PathGuard(policy), 'openai-tunnel');
  const sessionA = '11111111-1111-4111-8111-111111111111';
  const sessionB = '22222222-2222-4222-8222-222222222222';

  const started = await runWithWorkSession(sessionA, () =>
    manager.start('w', process.execPath, ['-e', "console.log('SESSION_A');setTimeout(()=>{}, 2000)"])
  );

  runWithWorkSession(sessionB, () => {
    assert.deepEqual(manager.list(), []);
    assert.throws(() => manager.read(started.id), /Unknown process id/);
    assert.throws(() => manager.readSince(started.id), /Unknown process id/);
  });
  await assert.rejects(
    runWithWorkSession(sessionB, () => manager.stop(started.id)),
    /Unknown process id/
  );

  await runWithWorkSession(sessionA, () => manager.stop(started.id));
  await sleep(50);
});
