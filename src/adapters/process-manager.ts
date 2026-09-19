import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import type { OutputChunk, ProcessInputResult, ProcessReadSince, ProcessSnapshot } from '../model.js';
import { PolicyEngine } from '../policy.js';
import { PathGuard } from '../security/path-guard.js';
import { resolveResourceOwner, type ResourceOwnerSource } from '../security/execution-context.js';
import { buildSafeEnvironment } from '../security/env-filter.js';
import { ProcessTreeSupervisor, type ProcessTreeTerminationResult } from './process-tree-supervisor.js';

type Managed = ProcessSnapshot & {
  child: ChildProcessWithoutNullStreams;
  timer?: NodeJS.Timeout;
  stdoutBase: number;
  stderrBase: number;
  ownerId: string;
  termination?: Promise<ProcessTreeTerminationResult>;
};

export class ProcessManager {
  private readonly processes = new Map<string, Managed>();
  private readonly treeSupervisor = new ProcessTreeSupervisor();

  constructor(
    private readonly policy: PolicyEngine,
    private readonly paths: PathGuard,
    private readonly ownerIdSource: ResourceOwnerSource = 'unknown'
  ) {}

  private ownerId(): string {
    return resolveResourceOwner(this.ownerIdSource).key;
  }

  private owned(id: string): Managed {
    const managed = this.processes.get(id);
    if (!managed || managed.ownerId !== this.ownerId()) {
      // Deliberately do not reveal whether a process exists for another principal or Work Session.
      throw new Error(`Unknown process id '${id}'.`);
    }
    return managed;
  }

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

  async start(workspace: string, program: string, args: string[], cwdRelative = '.', trustedEngineering = false): Promise<ProcessSnapshot> {
    this.policy.workspace(workspace);
    if (trustedEngineering) this.policy.assertEngineeringExecute();
    else this.policy.assertExecute(program);
    const cwd = await this.paths.resolveExisting(workspace, cwdRelative);
    const ownerId = this.ownerId();
    const child = spawn(program, args, {
      cwd,
      shell: false,
      windowsHide: true,
      detached: this.treeSupervisor.spawnDetached(),
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
      stdinOpen: true,
      stdoutBase: 0,
      stderrBase: 0,
      exitCode: null,
      startedAt: new Date().toISOString(),
      ownerId,
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
    child.stdin.on('close', () => {
      managed.stdinOpen = false;
    });
    child.on('error', error => {
      managed.status = 'failed';
      managed.stdinOpen = false;
      const next = this.append(managed.stderr, managed.stderrBase, Buffer.from(`\n${error.message}`));
      managed.stderr = next.text;
      managed.stderrBase = next.base;
      managed.endedAt = new Date().toISOString();
      if (managed.timer) clearTimeout(managed.timer);
    });
    child.on('close', code => {
      if (managed.status === 'running') managed.status = 'exited';
      managed.stdinOpen = false;
      managed.exitCode = code;
      managed.endedAt = new Date().toISOString();
      if (managed.timer) clearTimeout(managed.timer);
    });
    managed.timer = setTimeout(() => {
      if (managed.status === 'running') {
        void this.terminateManaged(managed);
      }
    }, this.policy.config.process.maxRuntimeMs);
    return this.snapshot(managed);
  }

  write(id: string, input: string, appendNewline = false): ProcessInputResult {
    const managed = this.owned(id);
    if (managed.status !== 'running') throw new Error(`Process '${id}' is not running.`);
    if (!managed.stdinOpen || managed.child.stdin.destroyed || managed.child.stdin.writableEnded) {
      managed.stdinOpen = false;
      throw new Error(`stdin for process '${id}' is closed.`);
    }

    const payload = appendNewline ? `${input}\n` : input;
    const bytes = Buffer.byteLength(payload, 'utf8');
    const max = this.policy.config.process.maxInputBytes ?? 64 * 1024;
    if (bytes > max) throw new Error(`stdin payload exceeds process.maxInputBytes (${max}).`);
    if (managed.child.stdin.writableLength + bytes > max) {
      throw new Error(`stdin backpressure limit exceeded (${max} queued bytes maximum).`);
    }

    try {
      managed.child.stdin.write(payload, 'utf8', error => {
        if (error) managed.stdinOpen = false;
      });
    } catch (error) {
      managed.stdinOpen = false;
      throw error;
    }
    return { id, acceptedBytes: bytes, stdinOpen: managed.stdinOpen };
  }

  closeStdin(id: string): ProcessSnapshot {
    const managed = this.owned(id);
    if (managed.stdinOpen && !managed.child.stdin.destroyed && !managed.child.stdin.writableEnded) {
      managed.stdinOpen = false;
      managed.child.stdin.end();
    } else {
      managed.stdinOpen = false;
    }
    return this.snapshot(managed);
  }

  read(id: string): ProcessSnapshot {
    return this.snapshot(this.owned(id));
  }

  readSince(id: string, stdoutCursor = 0, stderrCursor = 0): ProcessReadSince {
    const managed = this.owned(id);
    return {
      process: this.snapshot(managed),
      stdout: this.sliceSince(managed.stdout, managed.stdoutBase, stdoutCursor),
      stderr: this.sliceSince(managed.stderr, managed.stderrBase, stderrCursor)
    };
  }

  list(): ProcessSnapshot[] {
    const ownerId = this.ownerId();
    return [...this.processes.values()]
      .filter(item => item.ownerId === ownerId)
      .map(item => this.snapshot(item));
  }

  async stop(id: string): Promise<ProcessSnapshot> {
    const managed = this.owned(id);
    if (managed.status === 'running') {
      await this.terminateManaged(managed);
    }
    return this.snapshot(managed);
  }

  private async terminateManaged(managed: Managed): Promise<void> {
    if (managed.termination) {
      await managed.termination;
      return;
    }
    managed.status = 'stopped';
    managed.stdinOpen = false;
    if (managed.timer) clearTimeout(managed.timer);
    managed.termination = this.treeSupervisor.terminate(managed.child);
    const result = await managed.termination;
    managed.endedAt = new Date().toISOString();
    if (!result.treeExited) {
      const next = this.append(
        managed.stderr,
        managed.stderrBase,
        Buffer.from(`\nProcess tree cleanup incomplete for pid ${managed.pid ?? 'unknown'}.`)
      );
      managed.stderr = next.text;
      managed.stderrBase = next.base;
    }
  }

  private snapshot(managed: Managed): ProcessSnapshot {
    const {
      child: _child,
      timer: _timer,
      stdoutBase: _stdoutBase,
      stderrBase: _stderrBase,
      ownerId: _ownerId,
      termination: _termination,
      ...snapshot
    } = managed;
    return { ...snapshot, args: [...snapshot.args] };
  }
}
