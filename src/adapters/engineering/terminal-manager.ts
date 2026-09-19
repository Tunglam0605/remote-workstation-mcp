import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { TerminalReadResult, TerminalSessionSnapshot } from '../../engineering/types.js';
import { PolicyEngine } from '../../policy.js';
import { PathGuard } from '../../security/path-guard.js';
import { resolveResourceOwner, type ResourceOwnerSource } from '../../security/execution-context.js';
import { buildSafeEnvironment } from '../../security/env-filter.js';
import { resolveExecutablePath } from '../executable-resolver.js';
import { ProcessTreeSupervisor } from '../process-tree-supervisor.js';

type WorkerMessage =
  | { type: 'started'; pid: number }
  | { type: 'data'; data: string }
  | { type: 'exit'; exitCode: number }
  | { type: 'error'; message: string };

type ManagedTerminal = TerminalSessionSnapshot & {
  ownerId: string;
  worker?: ChildProcess;
  output: string;
  outputBase: number;
  exitPromise: Promise<void>;
  resolveExit: () => void;
  workerExitPromise: Promise<void>;
  resolveWorkerExit: () => void;
  nativeExited: boolean;
  workerExited: boolean;
  timer?: NodeJS.Timeout;
  stopping?: Promise<void>;
  workerStderr: string;
};

const PTY_WORKER_PATH = fileURLToPath(new URL('../../../scripts/pty-worker.cjs', import.meta.url));
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export class TerminalManager {
  private readonly sessions = new Map<string, ManagedTerminal>();
  private readonly treeSupervisor = new ProcessTreeSupervisor();

  constructor(
    private readonly policy: PolicyEngine,
    private readonly paths: PathGuard,
    private readonly ownerIdSource: ResourceOwnerSource = 'unknown'
  ) {}

  private ownerId(): string {
    return resolveResourceOwner(this.ownerIdSource).key;
  }

  private owned(id: string): ManagedTerminal {
    const session = this.sessions.get(id);
    if (!session || session.ownerId !== this.ownerId()) throw new Error("Unknown terminal session '" + id + "'.");
    return session;
  }

  private appendOutput(managed: ManagedTerminal, data: string): void {
    managed.output += data;
    const max = this.policy.config.process.maxOutputBytes;
    if (managed.output.length > max) {
      const removed = managed.output.length - max;
      managed.output = managed.output.slice(removed);
      managed.outputBase += removed;
    }
  }

  async start(
    workspace: string,
    program: string,
    args: string[],
    cwdRelative = '.',
    cols = 120,
    rows = 30
  ): Promise<TerminalSessionSnapshot> {
    this.policy.workspace(workspace);
    this.policy.assertExecute(program);
    const cwd = await this.paths.resolveExisting(workspace, cwdRelative);
    const resolvedProgram = await resolveExecutablePath(program, { cwd });
    if (!resolvedProgram) {
      throw new Error(`Allowlisted executable '${program}' could not be resolved without a shell.`);
    }
    if (!Number.isInteger(cols) || cols < 20 || cols > 500) throw new Error('Terminal cols must be in range 20..500.');
    if (!Number.isInteger(rows) || rows < 5 || rows > 200) throw new Error('Terminal rows must be in range 5..200.');

    const terminalEnv = buildSafeEnvironment(this.policy.config.process.inheritEnv) as Record<string, string>;
    terminalEnv.TERM ??= 'xterm-256color';
    const worker = spawn(process.execPath, [PTY_WORKER_PATH], {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: buildSafeEnvironment(this.policy.config.process.inheritEnv)
    });

    const id = randomUUID();
    let resolveExit!: () => void;
    const exitPromise = new Promise<void>(resolve => { resolveExit = resolve; });
    let resolveWorkerExit!: () => void;
    const workerExitPromise = new Promise<void>(resolve => { resolveWorkerExit = resolve; });
    const managed: ManagedTerminal = {
      id, workspace, program, args: [...args], cwd, pid: 0, cols, rows,
      status: 'running', startedAt: new Date().toISOString(), ownerId: this.ownerId(),
      worker, output: '', outputBase: 0, exitPromise, resolveExit, workerExitPromise, resolveWorkerExit,
      nativeExited: false, workerExited: false, workerStderr: ''
    };
    this.sessions.set(id, managed);

    let resolveStarted!: () => void;
    let rejectStarted!: (error: Error) => void;
    const startedPromise = new Promise<void>((resolve, reject) => {
      resolveStarted = resolve;
      rejectStarted = reject;
    });
    let startupSettled = false;
    const settleStarted = (error?: Error) => {
      if (startupSettled) return;
      startupSettled = true;
      if (error) rejectStarted(error);
      else resolveStarted();
    };

    worker.stderr?.on('data', chunk => {
      managed.workerStderr = (managed.workerStderr + (chunk as Buffer).toString('utf8')).slice(-8192);
    });
    worker.on('message', raw => {
      const message = raw as WorkerMessage;
      if (!message || typeof message !== 'object' || typeof message.type !== 'string') return;
      if (message.type === 'started') {
        if (!Number.isInteger(message.pid) || message.pid <= 0) {
          settleStarted(new Error('PTY worker returned an invalid process id.'));
          return;
        }
        managed.pid = message.pid;
        settleStarted();
        return;
      }
      if (message.type === 'data') {
        if (typeof message.data === 'string') this.appendOutput(managed, message.data);
        return;
      }
      if (message.type === 'exit') {
        managed.nativeExited = true;
        if (managed.status === 'running') managed.status = 'exited';
        managed.exitCode = Number.isInteger(message.exitCode) ? message.exitCode : -1;
        managed.endedAt = new Date().toISOString();
        if (managed.timer) clearTimeout(managed.timer);
        managed.resolveExit();
        return;
      }
      if (message.type === 'error') {
        const error = new Error('PTY worker: ' + message.message);
        if (!startupSettled) settleStarted(error);
        else if (managed.status === 'running') {
          managed.status = 'failed';
          managed.endedAt = new Date().toISOString();
          this.appendOutput(managed, '\n' + error.message);
        }
      }
    });
    worker.on('error', error => {
      if (!startupSettled) settleStarted(error);
      if (managed.status === 'running') managed.status = 'failed';
      managed.endedAt = new Date().toISOString();
      this.appendOutput(managed, '\nPTY worker process error: ' + error.message);
      managed.resolveExit();
    });
    worker.on('exit', (code, signal) => {
      managed.workerExited = true;
      managed.resolveWorkerExit();
      managed.worker = undefined;
      if (!managed.nativeExited) {
        if (managed.status === 'running') managed.status = 'failed';
        managed.exitCode = code ?? (signal ? -1 : managed.exitCode);
        managed.endedAt = new Date().toISOString();
        managed.resolveExit();
        if (!startupSettled) {
          settleStarted(new Error('PTY worker exited before startup completed (code=' + String(code) + ', signal=' + String(signal) + ').'));
        }
      }
    });

    if (!worker.connected || !worker.send) {
      settleStarted(new Error('PTY worker IPC channel is unavailable.'));
    } else {
      worker.send({ type: 'start', program: resolvedProgram, args, cwd, cols, rows, env: terminalEnv });
    }

    const startupTimeout = setTimeout(() => settleStarted(new Error('PTY worker startup timed out.')), 5000);
    try {
      await startedPromise;
    } catch (error) {
      if (worker.exitCode === null) await this.treeSupervisor.terminate(worker).catch(() => undefined);
      this.sessions.delete(id);
      const detail = managed.workerStderr ? ' Worker stderr: ' + managed.workerStderr : '';
      throw new Error("Unable to start PTY/ConPTY for '" + program + "': " + (error as Error).message + detail);
    } finally {
      clearTimeout(startupTimeout);
    }

    managed.timer = setTimeout(() => {
      if (managed.status === 'running') void this.stopInternal(managed);
    }, this.policy.config.process.maxRuntimeMs);
    managed.timer.unref();
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
    if (managed.status !== 'running') throw new Error("Terminal session '" + id + "' is not running.");
    const bytes = Buffer.byteLength(data, 'utf8');
    const max = this.policy.config.process.maxInputBytes ?? 64 * 1024;
    if (bytes > max) throw new Error('Terminal input exceeds process.maxInputBytes (' + max + ').');
    const worker = managed.worker;
    if (!worker?.connected || !worker.send) throw new Error("Terminal session '" + id + "' has no live PTY worker.");
    worker.send({ type: 'write', data });
    return { acceptedBytes: bytes };
  }

  resize(id: string, cols: number, rows: number): TerminalSessionSnapshot {
    const managed = this.owned(id);
    if (managed.status !== 'running') throw new Error("Terminal session '" + id + "' is not running.");
    if (!Number.isInteger(cols) || cols < 20 || cols > 500 || !Number.isInteger(rows) || rows < 5 || rows > 200) {
      throw new Error('Terminal size is out of range.');
    }
    const worker = managed.worker;
    if (!worker?.connected || !worker.send) throw new Error("Terminal session '" + id + "' has no live PTY worker.");
    worker.send({ type: 'resize', cols, rows });
    managed.cols = cols;
    managed.rows = rows;
    return this.snapshot(managed);
  }

  async stop(id: string): Promise<TerminalSessionSnapshot> {
    const managed = this.owned(id);
    if (managed.status === 'running') await this.stopInternal(managed);
    return this.snapshot(managed);
  }

  private async stopInternal(managed: ManagedTerminal): Promise<void> {
    if (managed.stopping) {
      await managed.stopping;
      return;
    }
    managed.stopping = (async () => {
      if (managed.timer) clearTimeout(managed.timer);
      const worker = managed.worker;
      if (!worker || managed.workerExited) return;

      managed.status = 'stopped';
      if (worker.connected && worker.send) {
        try { worker.send({ type: 'stop' }); } catch { /* forced cleanup below */ }
      }

      await Promise.race([managed.exitPromise, sleep(3500)]);
      if (!managed.nativeExited && managed.pid > 0) {
        await this.treeSupervisor.terminatePidTree(managed.pid, () => managed.nativeExited).catch(() => undefined);
      }

      await Promise.race([managed.workerExitPromise, sleep(1000)]);
      if (!managed.workerExited && worker.exitCode === null) {
        await this.treeSupervisor.terminate(worker).catch(() => undefined);
        await Promise.race([managed.workerExitPromise, sleep(1000)]);
      }

      managed.endedAt ??= new Date().toISOString();
      if (!managed.workerExited) {
        managed.status = 'failed';
        throw new Error("PTY worker cleanup incomplete for terminal '" + managed.id + "'.");
      }
    })();
    await managed.stopping;
  }

  list(): TerminalSessionSnapshot[] {
    const owner = this.ownerId();
    return [...this.sessions.values()].filter(item => item.ownerId === owner).map(item => this.snapshot(item));
  }

  private snapshot(managed: ManagedTerminal): TerminalSessionSnapshot {
    const {
      ownerId: _owner, worker: _worker, output: _output, outputBase: _base,
      exitPromise: _exitPromise, resolveExit: _resolveExit, workerExitPromise: _workerExitPromise,
      resolveWorkerExit: _resolveWorkerExit, nativeExited: _nativeExited, workerExited: _workerExited,
      timer: _timer, stopping: _stopping, workerStderr: _workerStderr, ...snapshot
    } = managed;
    return { ...snapshot, args: [...snapshot.args] };
  }
}
