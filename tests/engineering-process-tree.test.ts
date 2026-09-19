import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EngineeringCommandRunner } from '../src/adapters/engineering/command-runner.js';
import { ProcessManager } from '../src/adapters/process-manager.js';
import type { PolicyConfig } from '../src/model.js';
import { PolicyEngine } from '../src/policy.js';
import { PathGuard } from '../src/security/path-guard.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function processAlive(pid: number): Promise<boolean> {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitForFile(file: string, timeoutMs = 5000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return await fs.readFile(file, 'utf8'); } catch { await sleep(25); }
  }
  throw new Error(`Timed out waiting for ${file}`);
}

function treeParentScript(childPidFile: string, grandchildPidFile: string): string {
  const child = [
    "const {spawn}=require('node:child_process')",
    "const fs=require('node:fs')",
    `const g=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'})`,
    `fs.writeFileSync(${JSON.stringify(grandchildPidFile)},String(g.pid))`,
    "setInterval(()=>{},1000)"
  ].join(';');
  return [
    "const {spawn}=require('node:child_process')",
    "const fs=require('node:fs')",
    `const c=spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'ignore'})`,
    `fs.writeFileSync(${JSON.stringify(childPidFile)},String(c.pid))`,
    "setInterval(()=>{},1000)"
  ].join(';');
}

function config(root: string, maxRuntimeMs = 5000): PolicyConfig {
  return {
    version: 1,
    mode: 'workspace',
    workspaces: [{ id: 'w', root, readOnly: false }],
    filesystem: { maxReadBytes: 1024, maxWriteBytes: 1024 },
    process: {
      allowExecutables: [path.basename(process.execPath)],
      inheritEnv: ['PATH', 'HOME', 'TEMP', 'TMP'],
      maxOutputBytes: 65536,
      maxRuntimeMs,
      maxInputBytes: 1024
    },
    engineering: {
      enabled: true,
      maxCommandRuntimeMs: maxRuntimeMs,
      allowHardwareMutationInWorkspace: false,
      allowSerialWriteInWorkspace: false
    }
  };
}

async function assertTreeDead(childPid: number, grandchildPid: number): Promise<void> {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (!(await processAlive(childPid)) && !(await processAlive(grandchildPid))) return;
    await sleep(50);
  }
  assert.equal(await processAlive(childPid), false, `child pid ${childPid} survived process-tree cleanup`);
  assert.equal(await processAlive(grandchildPid), false, `grandchild pid ${grandchildPid} survived process-tree cleanup`);
}

async function bestEffortKill(pid: number | undefined): Promise<void> {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      const { execFile } = await import('node:child_process');
      await new Promise<void>(resolve => execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve()));
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch { /* test cleanup only */ }
}

test('engineering command timeout terminates child and grandchild process tree', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-tree-timeout-'));
  const childPidFile = path.join(root, 'child.pid');
  const grandchildPidFile = path.join(root, 'grandchild.pid');
  let childPid: number | undefined;
  let grandchildPid: number | undefined;
  try {
    const runner = new EngineeringCommandRunner(new PolicyEngine(config(root, 700)));
    const resultPromise = runner.run(
      process.execPath,
      ['-e', treeParentScript(childPidFile, grandchildPidFile)],
      root,
      450
    );
    childPid = Number(await waitForFile(childPidFile));
    grandchildPid = Number(await waitForFile(grandchildPidFile));
    const result = await resultPromise;
    assert.equal(result.timedOut, true);
    await assertTreeDead(childPid, grandchildPid);
  } finally {
    await bestEffortKill(childPid);
    await bestEffortKill(grandchildPid);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('managed process explicit stop waits for child and grandchild process-tree cleanup', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-tree-stop-'));
  const childPidFile = path.join(root, 'child.pid');
  const grandchildPidFile = path.join(root, 'grandchild.pid');
  let childPid: number | undefined;
  let grandchildPid: number | undefined;
  try {
    const policy = new PolicyEngine(config(root, 10_000));
    const manager = new ProcessManager(policy, new PathGuard(policy), 'owner');
    const started = await manager.start(
      'w',
      process.execPath,
      ['-e', treeParentScript(childPidFile, grandchildPidFile)]
    );
    childPid = Number(await waitForFile(childPidFile));
    grandchildPid = Number(await waitForFile(grandchildPidFile));

    const stopped = await manager.stop(started.id);
    assert.equal(stopped.status, 'stopped');
    await assertTreeDead(childPid, grandchildPid);
  } finally {
    await bestEffortKill(childPid);
    await bestEffortKill(grandchildPid);
    await fs.rm(root, { recursive: true, force: true });
  }
});
