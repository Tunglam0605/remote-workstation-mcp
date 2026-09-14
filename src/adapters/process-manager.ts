import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import type { ProcessSnapshot } from '../model.js';
import { PolicyEngine } from '../policy.js';
import { PathGuard } from '../security/path-guard.js';
import { buildSafeEnvironment } from '../security/env-filter.js';

type Managed = ProcessSnapshot & { child: ChildProcessWithoutNullStreams; timer?: NodeJS.Timeout };

export class ProcessManager {
  private readonly processes = new Map<string, Managed>();

  constructor(private readonly policy: PolicyEngine, private readonly paths: PathGuard) {}

  private append(current: string, chunk: Buffer): string {
    const next = current + chunk.toString('utf8');
    const max = this.policy.config.process.maxOutputBytes;
    return next.length <= max ? next : next.slice(next.length - max);
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
      exitCode: null,
      startedAt: new Date().toISOString(),
      child
    };
    this.processes.set(id, managed);
    child.stdout.on('data', chunk => { managed.stdout = this.append(managed.stdout, chunk as Buffer); });
    child.stderr.on('data', chunk => { managed.stderr = this.append(managed.stderr, chunk as Buffer); });
    child.on('error', error => {
      managed.status = 'failed';
      managed.stderr = this.append(managed.stderr, Buffer.from(`\n${error.message}`));
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
    const { child: _child, timer: _timer, ...snapshot } = managed;
    return { ...snapshot, args: [...snapshot.args] };
  }
}
