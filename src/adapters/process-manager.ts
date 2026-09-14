import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import type { OutputChunk, ProcessReadSince, ProcessSnapshot } from '../model.js';
import { PolicyEngine } from '../policy.js';
import { PathGuard } from '../security/path-guard.js';
import { buildSafeEnvironment } from '../security/env-filter.js';

type Managed = ProcessSnapshot & {
  child: ChildProcessWithoutNullStreams;
  timer?: NodeJS.Timeout;
  stdoutBase: number;
  stderrBase: number;
};

export class ProcessManager {
  private readonly processes = new Map<string, Managed>();

  constructor(private readonly policy: PolicyEngine, private readonly paths: PathGuard) {}

  private append(current: string, base: number, chunk: Buffer): { text: string; base: number } {
    let next = current + chunk.toString('utf8');
    let nextBase = base;
    const max = this.policy.config.process.maxOutputBytes;
    if (next.length > max) {
      const removed = next.length - max;
      next = next.slice(removed);
      nextBase += removed;
    }
    return { text: next, base: nextBase };
  }

  private sliceSince(text: string, base: number, cursor: number): OutputChunk {
    const normalizedCursor = Math.max(0, cursor);
    const truncated = normalizedCursor < base;
    const start = Math.max(normalizedCursor, base) - base;
    return { text: text.slice(start), nextCursor: base + text.length, truncated };
  }

  async start(workspace: string, program: string, args: string[], cwdRelative = '.'): Promise<ProcessSnapshot> {
    this.policy.workspace(workspace);
    this.policy.assertExecute(program);
    const cwd = await this.paths.resolveExisting(workspace, cwdRelative);
    const child = spawn(program, args, {
      cwd,
      shell: false,
      windowsHide: true,
      env: buildSafeEnvironment(this.policy.config.process.inheritEnv)
    });
    const id = randomUUID();
    const managed: Managed = {
      id,
      pid: child.pid,
      workspace,
      program: path.basename(program),
      args,
      cwd,
      status: 'running',
      stdout: '',
      stderr: '',
      stdoutBase: 0,
      stderrBase: 0,
      exitCode: null,
      startedAt: new Date().toISOString(),
      child
    };
    this.processes.set(id, managed);
    child.stdout.on('data', chunk => {
      const next = this.append(managed.stdout, managed.stdoutBase, chunk as Buffer);
      managed.stdout = next.text;
      managed.stdoutBase = next.base;
    });
    child.stderr.on('data', chunk => {
      const next = this.append(managed.stderr, managed.stderrBase, chunk as Buffer);
      managed.stderr = next.text;
      managed.stderrBase = next.base;
    });
    child.on('error', error => {
      managed.status = 'failed';
      const next = this.append(managed.stderr, managed.stderrBase, Buffer.from(`\n${error.message}`));
      managed.stderr = next.text;
      managed.stderrBase = next.base;
      managed.endedAt = new Date().toISOString();
      if (managed.timer) clearTimeout(managed.timer);
    });
    child.on('close', code => {
      if (managed.status === 'running') managed.status = 'exited';
      managed.exitCode = code;
      managed.endedAt = new Date().toISOString();
      if (managed.timer) clearTimeout(managed.timer);
    });
    managed.timer = setTimeout(() => {
      if (managed.status === 'running') {
        managed.status = 'stopped';
        child.kill('SIGTERM');
      }
    }, this.policy.config.process.maxRuntimeMs);
    return this.snapshot(managed);
  }

  read(id: string): ProcessSnapshot {
    const managed = this.processes.get(id);
    if (!managed) throw new Error(`Unknown process id '${id}'.`);
    return this.snapshot(managed);
  }

  readSince(id: string, stdoutCursor = 0, stderrCursor = 0): ProcessReadSince {
    const managed = this.processes.get(id);
    if (!managed) throw new Error(`Unknown process id '${id}'.`);
    return {
      process: this.snapshot(managed),
      stdout: this.sliceSince(managed.stdout, managed.stdoutBase, stdoutCursor),
      stderr: this.sliceSince(managed.stderr, managed.stderrBase, stderrCursor)
    };
  }

  list(): ProcessSnapshot[] {
    return [...this.processes.values()].map(item => this.snapshot(item));
  }

  stop(id: string): ProcessSnapshot {
    const managed = this.processes.get(id);
    if (!managed) throw new Error(`Unknown process id '${id}'.`);
    if (managed.status === 'running') {
      managed.status = 'stopped';
      managed.child.kill('SIGTERM');
      managed.endedAt = new Date().toISOString();
      if (managed.timer) clearTimeout(managed.timer);
    }
    return this.snapshot(managed);
  }

  private snapshot(managed: Managed): ProcessSnapshot {
    const { child: _child, timer: _timer, stdoutBase: _stdoutBase, stderrBase: _stderrBase, ...snapshot } = managed;
    return { ...snapshot, args: [...snapshot.args] };
  }
}
