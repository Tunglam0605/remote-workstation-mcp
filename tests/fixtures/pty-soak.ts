import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TerminalManager } from '../../src/adapters/engineering/terminal-manager.js';
import type { PolicyConfig } from '../../src/model.js';
import { PolicyEngine } from '../../src/policy.js';
import { PathGuard } from '../../src/security/path-guard.js';

const iterations = Math.max(20, Math.min(Number(process.env.RWMCP_PTY_SOAK_ITERATIONS ?? 120), 500));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function removeWorkspace(root: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await fs.rm(root, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(code ?? '')) throw error;
      await sleep(100);
    }
  }
  throw lastError;
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error('PTY soak wait timed out.');
}

function activeHandleCount(): number {
  const getter = (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles;
  return typeof getter === 'function' ? getter.call(process).length : 0;
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-pty-soak-'));
  const baselineHandles = activeHandleCount();
  const baselineRss = process.memoryUsage().rss;
  try {
    const config: PolicyConfig = {
      version: 1,
      mode: 'workspace',
      workspaces: [{ id: 'w', root, readOnly: false }],
      filesystem: { maxReadBytes: 1024 * 1024, maxWriteBytes: 1024 * 1024 },
      process: {
        allowExecutables: [process.execPath],
        inheritEnv: ['PATH', 'HOME', 'TEMP', 'TMP'],
        maxOutputBytes: 16 * 1024,
        maxRuntimeMs: 5000,
        maxInputBytes: 16 * 1024
      }
    };
    const policy = new PolicyEngine(config);
    const terminal = new TerminalManager(policy, new PathGuard(policy), 'pty-soak');

    for (let i = 0; i < iterations; i += 1) {
      const mode = i % 4;
      const workDirName = `iteration-${i}`;
      const workDir = path.join(root, workDirName);
      await fs.mkdir(workDir);
      if (mode === 0) {
        const session = await terminal.start('w', process.execPath, ['-e', `console.log('NATURAL_${i}')`], workDirName);
        await waitFor(() => terminal.read(session.id).session.status !== 'running');
        assert.match(terminal.read(session.id).text, new RegExp(`NATURAL_${i}`));
        await terminal.stop(session.id);
      } else if (mode === 1) {
        const session = await terminal.start('w', process.execPath, ['-e',
          "process.stdin.on('data',d=>process.stdout.write('ECHO:'+d));setInterval(()=>{},1000)"
        ], workDirName);
        terminal.resize(session.id, 100 + (i % 20), 24 + (i % 10));
        terminal.write(session.id, `PING_${i}\n`);
        await waitFor(() => terminal.read(session.id).text.includes(`PING_${i}`));
        const stopped = await terminal.stop(session.id);
        assert.notEqual(stopped.status, 'running');
      } else if (mode === 2) {
        const session = await terminal.start('w', process.execPath, ['-e',
          "process.stdin.resume();setInterval(()=>{},1000)"
        ], workDirName);
        terminal.resize(session.id, 80 + (i % 30), 20 + (i % 15));
        const stopping = terminal.stop(session.id);
        try { terminal.write(session.id, 'RACE\n'); } catch { /* valid write-vs-stop race outcome */ }
        const stopped = await stopping;
        assert.notEqual(stopped.status, 'running');
      } else {
        const session = await terminal.start('w', process.execPath, ['-e', "process.stdout.write('EXITING')"], workDirName);
        await waitFor(() => terminal.read(session.id).session.status !== 'running');
        assert.throws(() => terminal.write(session.id, 'AFTER_EXIT'), /not running|no live PTY/i);
        await terminal.stop(session.id);
      }

      try {
        await removeWorkspace(workDir);
      } catch (error) {
        throw new Error(`PTY lifecycle ${i} mode=${mode} did not release cwd: ${error instanceof Error ? error.message : String(error)}`);
      }

      if ((i + 1) % 25 === 0) {
        if (typeof global.gc === 'function') global.gc();
        await sleep(25);
        process.stderr.write(`PTY_SOAK_PROGRESS ${i + 1}/${iterations}\n`);
      }
    }

    if (typeof global.gc === 'function') global.gc();
    await sleep(250);
    const finalHandles = activeHandleCount();
    const finalRss = process.memoryUsage().rss;
    const handleDelta = finalHandles - baselineHandles;
    const rssDelta = finalRss - baselineRss;

    assert.ok(handleDelta <= 16, `PTY soak leaked active handles: baseline=${baselineHandles}, final=${finalHandles}`);
    assert.ok(rssDelta <= 192 * 1024 * 1024, `PTY soak RSS growth too large: ${rssDelta} bytes`);

    process.stdout.write(JSON.stringify({
      iterations,
      platform: process.platform,
      baselineHandles,
      finalHandles,
      handleDelta,
      baselineRss,
      finalRss,
      rssDelta,
      sessionsRetained: terminal.list().length
    }) + '\n');
  } finally {
    await removeWorkspace(root);
  }
}

await main();
