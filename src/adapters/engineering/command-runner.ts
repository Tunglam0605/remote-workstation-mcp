import { spawn } from 'node:child_process';
import type { EngineeringCommandResult } from '../../engineering/types.js';
import { PolicyEngine } from '../../policy.js';
import { buildSafeEnvironment } from '../../security/env-filter.js';

export class EngineeringCommandRunner {
  constructor(private readonly policy: PolicyEngine) {}

  async run(program: string, args: string[], cwd: string, timeoutMs?: number): Promise<EngineeringCommandResult> {
    this.policy.assertEngineeringExecute();
    const started = Date.now();
    const engineeringMax = this.policy.config.engineering?.maxCommandRuntimeMs ?? this.policy.config.process.maxRuntimeMs;
    const limit = Math.min(timeoutMs ?? engineeringMax, engineeringMax);
    const maxOutput = this.policy.config.process.maxOutputBytes;
    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;
      let child;
      try {
        child = spawn(program, args, {
          cwd,
          shell: false,
          windowsHide: true,
          env: buildSafeEnvironment(this.policy.config.process.inheritEnv)
        });
      } catch (error) {
        reject(error);
        return;
      }
      const append = (current: string, chunk: Buffer) => {
        const next = current + chunk.toString('utf8');
        return next.length > maxOutput ? next.slice(next.length - maxOutput) : next;
      };
      child.stdout.on('data', chunk => { stdout = append(stdout, chunk as Buffer); });
      child.stderr.on('data', chunk => { stderr = append(stderr, chunk as Buffer); });
      child.on('error', error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', code => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ program, args: [...args], cwd, exitCode: code, stdout, stderr, timedOut, durationMs: Date.now() - started });
      });
      const timer = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!settled) child.kill('SIGKILL');
        }, 2000).unref();
      }, limit);
    });
  }
}
