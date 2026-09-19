import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { HostsConfig, SshHostConfig } from '../model.js';
import { PolicyEngine } from '../policy.js';
import { buildSafeEnvironment } from '../security/env-filter.js';

const exec = promisify(execFile);

export function quotePosix(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function quotePowerShellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function encodePowerShellScript(script: string): string {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
}

export function buildWindowsPowerShellRemoteCommand(program: string, args: string[] = [], cwd?: string): string {
  const lines = ["$ErrorActionPreference = 'Stop'"];
  if (cwd) lines.push(`Set-Location -LiteralPath ${quotePowerShellLiteral(cwd)}`);
  lines.push(`$__rwmcpProgram = ${quotePowerShellLiteral(program)}`);
  lines.push(`$__rwmcpArgs = @(${args.map(quotePowerShellLiteral).join(', ')})`);
  lines.push('& $__rwmcpProgram @__rwmcpArgs');
  lines.push('exit $LASTEXITCODE');
  return encodePowerShellScript(lines.join('\r\n'));
}

function remoteShell(host: SshHostConfig): 'posix' | 'windows-powershell' {
  return host.remoteShell ?? 'posix';
}

function remoteCwd(host: SshHostConfig, cwd: string): string | undefined {
  if (cwd === '.' && !host.remoteRoot) return undefined;
  const windows = remoteShell(host) === 'windows-powershell';
  const pathApi = windows ? path.win32 : path.posix;
  if (pathApi.isAbsolute(cwd)) throw new Error('SSH cwd must be relative to the configured remoteRoot.');
  const normalized = pathApi.normalize(cwd);
  if (normalized === '..' || normalized.startsWith(`..${pathApi.sep}`)) throw new Error('SSH cwd escapes remoteRoot.');
  if (!host.remoteRoot) throw new Error(`SSH host '${host.id}' has no remoteRoot; cwd must be '.'.`);
  if (!pathApi.isAbsolute(host.remoteRoot)) throw new Error(`SSH host '${host.id}' remoteRoot must be absolute.`);
  return pathApi.join(host.remoteRoot, normalized);
}

function destination(host: SshHostConfig): string {
  const hostname = host.hostname.includes(':') && !host.hostname.startsWith('[') ? `[${host.hostname}]` : host.hostname;
  return `${host.user}@${hostname}`;
}

export class SshAdapter {
  constructor(private readonly policy: PolicyEngine, private readonly hostsConfig: HostsConfig) {}

  private host(id: string): SshHostConfig {
    const host = this.hostsConfig.hosts.find(item => item.id === id);
    if (!host) throw new Error(`SSH host '${id}' is not authorized by the local owner configuration.`);
    return host;
  }

  private assertRemoteExecution(host: SshHostConfig, program: string): void {
    if (this.policy.config.mode === 'read_only') throw new Error('SSH execution is disabled in read_only mode.');
    const containsPath = program.includes('/') || program.includes('\\');
    const basename = remoteShell(host) === 'windows-powershell' ? path.win32.basename : path.posix.basename;
    const allowed = containsPath
      ? host.allowPrograms.includes(program)
      : host.allowPrograms.some(item => basename(item).toLowerCase() === program.toLowerCase());
    if (!allowed) throw new Error(`Remote program '${program}' is not allowed for SSH host '${host.id}'.`);
  }

  private async baseArgs(host: SshHostConfig): Promise<string[]> {
    const args = [
      '-T',
      '-o', 'BatchMode=yes',
      '-o', 'ClearAllForwardings=yes',
      '-o', 'PermitLocalCommand=no',
      '-o', 'RequestTTY=no',
      '-o', 'ConnectTimeout=8',
      '-o', `StrictHostKeyChecking=${host.strictHostKeyChecking}`,
      '-p', String(host.port)
    ];
    if (host.auth === 'identity_file') {
      if (!host.identityFile) throw new Error(`SSH host '${host.id}' is missing identityFile.`);
      await fs.access(host.identityFile, fs.constants.R_OK);
      args.push('-i', host.identityFile, '-o', 'IdentitiesOnly=yes');
    }
    return args;
  }

  listHosts() {
    if (!this.policy.legacyRemoteControlEnabled()) return [];
    return this.hostsConfig.hosts.map(host => ({
      id: host.id,
      name: host.name ?? host.id,
      hostname: host.hostname,
      port: host.port,
      user: host.user,
      auth: host.auth,
      strictHostKeyChecking: host.strictHostKeyChecking,
      remoteShell: remoteShell(host),
      remoteRoot: host.remoteRoot,
      allowPrograms: [...host.allowPrograms],
      maxRuntimeMs: host.maxRuntimeMs
    }));
  }

  async probe(id: string) {
    this.policy.assertLegacyRemoteControl();
    const host = this.host(id);
    const args = await this.baseArgs(host);
    const probeCommand = remoteShell(host) === 'windows-powershell'
      ? encodePowerShellScript('exit 0')
      : 'true';
    args.push('--', destination(host), probeCommand);
    const started = Date.now();
    try {
      await exec('ssh', args, {
        timeout: Math.min(host.maxRuntimeMs, 10000),
        windowsHide: true,
        env: buildSafeEnvironment([...this.policy.config.process.inheritEnv, 'SSH_AUTH_SOCK'])
      });
      return { host: id, reachable: true, durationMs: Date.now() - started };
    } catch (error) {
      const e = error as NodeJS.ErrnoException & { stderr?: string };
      return { host: id, reachable: false, durationMs: Date.now() - started, error: e.stderr?.trim() || e.message };
    }
  }

  async execute(id: string, program: string, args: string[] = [], cwd = '.', timeoutMs?: number) {
    this.policy.assertLegacyRemoteControl();
    const host = this.host(id);
    this.assertRemoteExecution(host, program);
    const base = await this.baseArgs(host);
    const requestedCwd = remoteCwd(host, cwd);
    const remoteCommand = remoteShell(host) === 'windows-powershell'
      ? buildWindowsPowerShellRemoteCommand(program, args, requestedCwd)
      : (() => {
          const command = [quotePosix(program), ...args.map(quotePosix)].join(' ');
          return requestedCwd ? `cd -- ${quotePosix(requestedCwd)} && exec ${command}` : `exec ${command}`;
        })();
    base.push('--', destination(host), remoteCommand);
    const effectiveTimeout = Math.min(Math.max(timeoutMs ?? host.maxRuntimeMs, 1), host.maxRuntimeMs);
    try {
      const output = await exec('ssh', base, {
        timeout: effectiveTimeout,
        maxBuffer: this.policy.config.process.maxOutputBytes,
        windowsHide: true,
        env: buildSafeEnvironment([...this.policy.config.process.inheritEnv, 'SSH_AUTH_SOCK'])
      });
      return { host: id, program, ok: true, exitCode: 0, stdout: output.stdout, stderr: output.stderr };
    } catch (error) {
      const e = error as Error & { code?: number | string; stdout?: string; stderr?: string; killed?: boolean };
      return {
        host: id,
        program,
        ok: false,
        exitCode: typeof e.code === 'number' ? e.code : null,
        killed: Boolean(e.killed),
        stdout: e.stdout ?? '',
        stderr: e.stderr ?? e.message
      };
    }
  }
}
