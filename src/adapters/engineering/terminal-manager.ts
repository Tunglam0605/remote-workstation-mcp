import { randomUUID } from 'node:crypto';
import * as pty from 'node-pty';
import type { TerminalReadResult, TerminalSessionSnapshot } from '../../engineering/types.js';
import { PolicyEngine } from '../../policy.js';
import { PathGuard } from '../../security/path-guard.js';
import { buildSafeEnvironment } from '../../security/env-filter.js';

type OwnerIdSource = string | (() => string);

type ManagedTerminal = TerminalSessionSnapshot & {
  ownerId: string;
  process: pty.IPty;
  output: string;
  outputBase: number;
  exitPromise: Promise<void>;
  resolveExit: () => void;
};

export class TerminalManager {
  private readonly sessions = new Map<string, ManagedTerminal>();

  constructor(
    private readonly policy: PolicyEngine,
    private readonly paths: PathGuard,
    private readonly ownerIdSource: OwnerIdSource = 'unknown'
  ) {}

  private ownerId(): string {
    const value = typeof this.ownerIdSource === 'function' ? this.ownerIdSource() : this.ownerIdSource;
    return value || 'unknown';
  }

  private owned(id: string): ManagedTerminal {
    const session = this.sessions.get(id);
    if (!session || session.ownerId !== this.ownerId()) throw new Error(`Unknown terminal session '${id}'.`);
    return session;
  }

  async start(workspace: string, program: string, args: string[], cwdRelative = '.', cols = 120, rows = 30): Promise<TerminalSessionSnapshot> {
    this.policy.workspace(workspace);
    this.policy.assertExecute(program);
    const cwd = await this.paths.resolveExisting(workspace, cwdRelative);
    if (!Number.isInteger(cols) || cols < 20 || cols > 500) throw new Error('Terminal cols must be in range 20..500.');
    if (!Number.isInteger(rows) || rows < 5 || rows > 200) throw new Error('Terminal rows must be in range 5..200.');
    const env = buildSafeEnvironment(this.policy.config.process.inheritEnv) as Record<string, string>;
    env.TERM ??= 'xterm-256color';
    let terminal: pty.IPty;
    try {
      terminal = pty.spawn(program, args, {
        name: 'xterm-256color', cols, rows, cwd, env
      });
    } catch (error) {
      throw new Error(`Unable to start PTY/ConPTY for '${program}': ${(error as Error).message}`);
    }

    const id = randomUUID();
    let resolveExit!: () => void;
    const exitPromise = new Promise<void>(resolve => { resolveExit = resolve; });
    const managed: ManagedTerminal = {
      id, workspace, program, args: [...args], cwd, pid: terminal.pid, cols, rows,
      status: 'running', startedAt: new Date().toISOString(), ownerId: this.ownerId(), process: terminal,
      output: '', outputBase: 0, exitPromise, resolveExit
    };
    const max = this.policy.config.process.maxOutputBytes;
    terminal.onData(data => {
      managed.output += data;
      if (managed.output.length > max) {
        const removed = managed.output.length - max;
        managed.output = managed.output.slice(removed);
        managed.outputBase += removed;
      }
    });
    terminal.onExit(event => {
      if (managed.status === 'running') managed.status = 'exited';
      managed.exitCode = event.exitCode;
      managed.endedAt = new Date().toISOString();
      managed.resolveExit();
      if (process.platform === 'win32') {
        try { terminal.kill(); } catch { /* best-effort native handle cleanup after natural ConPTY exit */ }
      }
    });
    this.sessions.set(id, managed);
    return this.snapshot(managed);
  }

  read(id: string, cursor = 0): TerminalReadResult {
    const managed = this.owned(id);
    const normalized = Math.max(0, Math.floor(cursor));
    const truncated = normalized < managed.outputBase;
    const start = Math.max(normalized, managed.outputBase) - managed.outputBase;
    return {
      session: this.snapshot(managed),
      text: managed.output.slice(start),
      nextCursor: managed.outputBase + managed.output.length,
      truncated
    };
  }

  write(id: string, data: string): { acceptedBytes: number } {
    const managed = this.owned(id);
    if (managed.status !== 'running') throw new Error(`Terminal session '${id}' is not running.`);
    const bytes = Buffer.byteLength(data, 'utf8');
    const max = this.policy.config.process.maxInputBytes ?? 64 * 1024;
    if (bytes > max) throw new Error(`Terminal input exceeds process.maxInputBytes (${max}).`);
    managed.process.write(data);
    return { acceptedBytes: bytes };
  }

  resize(id: string, cols: number, rows: number): TerminalSessionSnapshot {
    const managed = this.owned(id);
    if (managed.status !== 'running') throw new Error(`Terminal session '${id}' is not running.`);
    if (!Number.isInteger(cols) || cols < 20 || cols > 500 || !Number.isInteger(rows) || rows < 5 || rows > 200) {
      throw new Error('Terminal size is out of range.');
    }
    managed.process.resize(cols, rows);
    managed.cols = cols;
    managed.rows = rows;
    return this.snapshot(managed);
  }

  async stop(id: string): Promise<TerminalSessionSnapshot> {
    const managed = this.owned(id);
    if (managed.status === 'running') {
      await Promise.race([
        managed.exitPromise,
        new Promise<void>(resolve => setTimeout(resolve, 150))
      ]);
    }
    if (managed.status === 'running') {
      managed.status = 'stopped';
      managed.process.kill();
      managed.endedAt = new Date().toISOString();
      await Promise.race([
        managed.exitPromise,
        new Promise<void>(resolve => setTimeout(resolve, 500))
      ]);
    }
    return this.snapshot(managed);
  }

  list(): TerminalSessionSnapshot[] {
    const owner = this.ownerId();
    return [...this.sessions.values()].filter(item => item.ownerId === owner).map(item => this.snapshot(item));
  }

  private snapshot(managed: ManagedTerminal): TerminalSessionSnapshot {
    const {
      ownerId: _owner,
      process: _process,
      output: _output,
      outputBase: _base,
      exitPromise: _exitPromise,
      resolveExit: _resolveExit,
      ...snapshot
    } = managed;
    return { ...snapshot, args: [...snapshot.args] };
  }
}
