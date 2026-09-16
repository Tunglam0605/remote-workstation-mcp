import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EngineeringCommandRunner } from '../src/adapters/engineering/command-runner.js';
import type { PolicyConfig } from '../src/model.js';
import { PolicyEngine } from '../src/policy.js';

async function processAlive(pid: number): Promise<boolean> {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test('engineering command timeout terminates descendant process tree', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-tree-'));
  const pidFile = path.join(root, 'child.pid');
  try {
    const config: PolicyConfig = {
      version: 1, mode: 'workspace', workspaces: [{ id: 'w', root, readOnly: false }],
      filesystem: { maxReadBytes: 1024, maxWriteBytes: 1024 },
      process: { allowExecutables: [], inheritEnv: ['PATH', 'HOME', 'TEMP', 'TMP'], maxOutputBytes: 65536, maxRuntimeMs: 5000, maxInputBytes: 1024 },
      engineering: { enabled: true, maxCommandRuntimeMs: 500, allowHardwareMutationInWorkspace: false, allowSerialWriteInWorkspace: false }
    };
    const runner = new EngineeringCommandRunner(new PolicyEngine(config));
    const parent = [
      "const {spawn}=require('node:child_process')",
      `const fs=require('node:fs'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid)); setInterval(()=>{},1000)`
    ].join(';');
    const result = await runner.run(process.execPath, ['-e', parent], root, 300);
    assert.equal(result.timedOut, true);
    const pid = Number(await fs.readFile(pidFile, 'utf8'));
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(await processAlive(pid), false, `descendant pid ${pid} survived provider timeout`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
