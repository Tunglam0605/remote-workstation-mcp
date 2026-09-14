import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PolicyEngine } from '../policy.js';
import { buildSafeEnvironment } from '../security/env-filter.js';

const exec = promisify(execFile);

export class FullControlAdapter {
  constructor(private readonly policy: PolicyEngine) {}

  async shell(command: string, cwd?: string, timeoutMs?: number) {
    this.policy.assertRawShell();
    if (!command.trim()) throw new Error('command must not be empty.');
    const effectiveTimeout = Math.min(
      Math.max(timeoutMs ?? this.policy.config.process.maxRuntimeMs, 1),
      this.policy.config.process.maxRuntimeMs
    );
    const platform = os.platform();
    const program = platform === 'win32' ? 'powershell.exe' : '/bin/bash';
    const args = platform === 'win32'
      ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command]
      : ['--noprofile', '--norc', '-lc', command];
    try {
      const output = await exec(program, args, {
        cwd,
        timeout: effectiveTimeout,
        maxBuffer: this.policy.config.process.maxOutputBytes,
        windowsHide: true,
        env: buildSafeEnvironment(this.policy.config.process.inheritEnv)
      });
      return { ok: true, exitCode: 0, stdout: output.stdout, stderr: output.stderr };
    } catch (error) {
      const e = error as Error & { code?: number | string; stdout?: string; stderr?: string; killed?: boolean };
      return {
        ok: false,
        exitCode: typeof e.code === 'number' ? e.code : null,
        killed: Boolean(e.killed),
        stdout: e.stdout ?? '',
        stderr: e.stderr ?? e.message
      };
    }
  }
}
