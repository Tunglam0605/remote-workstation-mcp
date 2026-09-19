import { execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ProcessTreeTerminationResult {
  pid?: number;
  platform: NodeJS.Platform;
  strategy: 'posix-process-group' | 'windows-taskkill-tree' | 'windows-native-then-taskkill' | 'child-process-fallback' | 'already-exited';
  gracefulRequested: boolean;
  forced: boolean;
  treeExited: boolean;
  errors: string[];
  durationMs: number;
}

export interface ProcessTreeSupervisorOptions {
  graceMs?: number;
  pollIntervalMs?: number;
  preferNativeGracefulKill?: boolean;
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function exited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

export class ProcessTreeSupervisor {
  private readonly graceMs: number;
  private readonly pollIntervalMs: number;

  constructor(options: ProcessTreeSupervisorOptions = {}) {
    this.graceMs = Math.max(100, Math.min(options.graceMs ?? 2000, 30_000));
    this.pollIntervalMs = Math.max(10, Math.min(options.pollIntervalMs ?? 50, 500));
  }

  /**
   * POSIX children must be spawned detached so their pid becomes a new process-group id.
   * Windows uses taskkill /T for descendant-aware termination and does not need detached mode.
   */
  spawnDetached(): boolean {
    return process.platform !== 'win32';
  }

  private posixGroupAlive(pid: number): boolean {
    try {
      process.kill(-pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private async waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await sleep(Math.min(this.pollIntervalMs, Math.max(1, deadline - Date.now())));
    }
    return predicate();
  }

  private async windowsTaskkill(pid: number, force: boolean): Promise<void> {
    const args = ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])];
    await execFileAsync('taskkill.exe', args, {
      windowsHide: true,
      timeout: Math.max(2000, this.graceMs),
      maxBuffer: 256 * 1024
    });
  }

  async terminatePidTree(
    pid: number,
    rootExited: () => boolean,
    fallbackKill?: () => void,
    options: ProcessTreeSupervisorOptions = {}
  ): Promise<ProcessTreeTerminationResult> {
    const started = Date.now();
    const graceMs = Math.max(100, Math.min(options.graceMs ?? this.graceMs, 30_000));
    const errors: string[] = [];

    if (rootExited()) {
      return {
        pid,
        platform: process.platform,
        strategy: 'already-exited',
        gracefulRequested: false,
        forced: false,
        treeExited: true,
        errors,
        durationMs: Date.now() - started
      };
    }

    if (!Number.isInteger(pid) || pid <= 0) {
      if (!fallbackKill) {
        return {
          pid,
          platform: process.platform,
          strategy: 'child-process-fallback',
          gracefulRequested: false,
          forced: false,
          treeExited: false,
          errors: ['Process tree pid is not available and no native fallback kill is registered.'],
          durationMs: Date.now() - started
        };
      }
      try { fallbackKill(); } catch (error) { errors.push(errorText(error)); }
      const treeExited = await this.waitUntil(rootExited, graceMs);
      return {
        pid,
        platform: process.platform,
        strategy: 'child-process-fallback',
        gracefulRequested: true,
        forced: false,
        treeExited,
        errors,
        durationMs: Date.now() - started
      };
    }

    if (process.platform === 'win32') {
      let forced = false;
      if (options.preferNativeGracefulKill && fallbackKill) {
        try { fallbackKill(); } catch (error) { errors.push(errorText(error)); }
        let treeExited = await this.waitUntil(rootExited, graceMs);
        if (!treeExited) {
          forced = true;
          try {
            await this.windowsTaskkill(pid, true);
          } catch (error) {
            if (!rootExited()) errors.push(errorText(error));
          }
          treeExited = await this.waitUntil(rootExited, Math.min(graceMs, 2000));
        }
        return {
          pid,
          platform: process.platform,
          strategy: 'windows-native-then-taskkill',
          gracefulRequested: true,
          forced,
          treeExited,
          errors,
          durationMs: Date.now() - started
        };
      }

      try {
        await this.windowsTaskkill(pid, false);
      } catch (error) {
        if (!rootExited()) errors.push(errorText(error));
      }

      let treeExited = await this.waitUntil(rootExited, graceMs);
      if (!treeExited) {
        forced = true;
        try {
          await this.windowsTaskkill(pid, true);
        } catch (error) {
          if (!rootExited()) errors.push(errorText(error));
        }
        treeExited = await this.waitUntil(rootExited, Math.min(graceMs, 2000));
      }

      if (!treeExited && fallbackKill) {
        try { fallbackKill(); } catch (error) { errors.push(errorText(error)); }
        treeExited = await this.waitUntil(rootExited, 500);
      }

      return {
        pid,
        platform: process.platform,
        strategy: 'windows-taskkill-tree',
        gracefulRequested: true,
        forced,
        treeExited,
        errors,
        durationMs: Date.now() - started
      };
    }

    try {
      process.kill(-pid, 'SIGTERM');
    } catch (error) {
      if (this.posixGroupAlive(pid)) errors.push(errorText(error));
      if (fallbackKill) {
        try { fallbackKill(); } catch (fallbackError) { errors.push(errorText(fallbackError)); }
      }
    }

    let treeExited = await this.waitUntil(() => !this.posixGroupAlive(pid), graceMs);
    let forced = false;
    if (!treeExited) {
      forced = true;
      try {
        process.kill(-pid, 'SIGKILL');
      } catch (error) {
        if (this.posixGroupAlive(pid)) errors.push(errorText(error));
      }
      treeExited = await this.waitUntil(() => !this.posixGroupAlive(pid), Math.min(graceMs, 2000));
    }

    return {
      pid,
      platform: process.platform,
      strategy: 'posix-process-group',
      gracefulRequested: true,
      forced,
      treeExited,
      errors,
      durationMs: Date.now() - started
    };
  }

  async terminate(child: ChildProcess, options: ProcessTreeSupervisorOptions = {}): Promise<ProcessTreeTerminationResult> {
    const pid = child.pid;
    if (!pid) {
      return {
        pid,
        platform: process.platform,
        strategy: 'already-exited',
        gracefulRequested: false,
        forced: false,
        treeExited: true,
        errors: [],
        durationMs: 0
      };
    }
    return await this.terminatePidTree(
      pid,
      () => exited(child),
      () => { child.kill(process.platform === 'win32' ? undefined : 'SIGTERM'); },
      options
    );
  }

}
