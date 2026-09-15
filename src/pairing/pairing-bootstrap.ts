import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import type { HostsConfig, SshHostConfig } from '../model.js';
import { buildSafeEnvironment } from '../security/env-filter.js';
import { PairingStore } from './pairing-store.js';

const POSIX_CONFIG_COMMAND = `set -eu; umask 077; base="\${XDG_CONFIG_HOME:-$HOME/.config}/remote-workstation-mcp"; mkdir -p "$base"; tmp="$base/device.json.tmp"; cat > "$tmp"; chmod 600 "$tmp"; mv "$tmp" "$base/device.json"; printf '%s' "$base/device.json"`;
const POSIX_INFO_COMMAND = `set -eu; printf '%s\n' "$(uname -s 2>/dev/null || printf unknown)" "$(uname -m 2>/dev/null || printf unknown)" "$(hostname 2>/dev/null || printf unknown)"`;
const WINDOWS_INFO_COMMAND = `powershell.exe -NoLogo -NoProfile -NonInteractive -Command "$ErrorActionPreference='Stop'; [Console]::Out.WriteLine('win32'); [Console]::Out.WriteLine($env:PROCESSOR_ARCHITECTURE); [Console]::Out.WriteLine($env:COMPUTERNAME)"`;
const WINDOWS_CONFIG_COMMAND = `powershell.exe -NoLogo -NoProfile -NonInteractive -Command "$ErrorActionPreference='Stop'; $base=Join-Path ($env:LOCALAPPDATA ?? (Join-Path $HOME 'AppData\\Local')) 'RemoteWorkstationMCP\\paired-agent'; New-Item -ItemType Directory -Force -Path $base | Out-Null; $target=Join-Path $base 'device.json'; $tmp=\"$target.tmp\"; $text=[Console]::In.ReadToEnd(); [IO.File]::WriteAllText($tmp,$text,(New-Object Text.UTF8Encoding($false))); Move-Item -Force $tmp $target; [Console]::Out.Write($target)"`;

interface RemoteResult {
  code: number;
  stdout: string;
  stderr: string;
}

function destination(host: SshHostConfig): string {
  const hostname = host.hostname.includes(':') && !host.hostname.startsWith('[') ? `[${host.hostname}]` : host.hostname;
  return `${host.user}@${hostname}`;
}

export class PairingBootstrapAdapter {
  constructor(
    private readonly hosts: HostsConfig,
    private readonly store: PairingStore,
    private readonly serverVersion: string
  ) {}

  private host(id: string): SshHostConfig {
    const host = this.hosts.hosts.find(item => item.id === id);
    if (!host) throw new Error(`SSH host '${id}' is not configured by the local owner.`);
    return host;
  }

  private async sshArgs(host: SshHostConfig): Promise<string[]> {
    const args = [
      '-T', '-o', 'BatchMode=yes', '-o', 'ClearAllForwardings=yes', '-o', 'PermitLocalCommand=no',
      '-o', 'RequestTTY=no', '-o', 'ConnectTimeout=8', '-o', `StrictHostKeyChecking=${host.strictHostKeyChecking}`,
      '-p', String(host.port)
    ];
    if (host.auth === 'identity_file') {
      if (!host.identityFile) throw new Error(`SSH host '${host.id}' is missing identityFile.`);
      await fs.access(host.identityFile, fs.constants.R_OK);
      args.push('-i', host.identityFile, '-o', 'IdentitiesOnly=yes');
    }
    return args;
  }

  private async run(host: SshHostConfig, command: string, stdin = '', timeoutMs = 15000): Promise<RemoteResult> {
    const args = await this.sshArgs(host);
    args.push('--', destination(host), command);
    return await new Promise<RemoteResult>((resolve, reject) => {
      const child = spawn('ssh', args, {
        shell: false,
        windowsHide: true,
        env: buildSafeEnvironment(['PATH', 'USERPROFILE', 'HOME', 'TEMP', 'TMP', 'SSH_AUTH_SOCK']),
        stdio: ['pipe', 'pipe', 'pipe']
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => child.kill(), timeoutMs);
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
      child.stdin.end(stdin, 'utf8');
    });
  }

  private async detect(host: SshHostConfig) {
    const posix = await this.run(host, POSIX_INFO_COMMAND, '', 10000);
    if (posix.code === 0) {
      const [platform = 'unknown', arch = 'unknown', hostname = host.hostname] = posix.stdout.trim().split(/\r?\n/);
      return { family: 'posix' as const, platform: platform.toLowerCase(), arch, hostname };
    }
    const windows = await this.run(host, WINDOWS_INFO_COMMAND, '', 10000);
    if (windows.code === 0) {
      const [platform = 'win32', arch = 'unknown', hostname = host.hostname] = windows.stdout.trim().split(/\r?\n/);
      return { family: 'windows' as const, platform: platform.toLowerCase(), arch, hostname };
    }
    throw new Error(`Unable to identify remote platform for '${host.id}': ${posix.stderr.trim() || windows.stderr.trim() || 'no response'}`);
  }

  async bootstrapSsh(input: { hostId: string; code: string; name?: string }) {
    const pending = await this.store.inspectCode(input.code);
    if (pending.bootstrapHostId && pending.bootstrapHostId !== input.hostId) {
      throw new Error('Pairing code is bound to a different SSH host.');
    }
    const host = this.host(input.hostId);
    const remote = await this.detect(host);
    const deviceId = `dev_${crypto.randomBytes(12).toString('hex')}`;
    const credential = `rwmcp_dev_${crypto.randomBytes(32).toString('base64url')}`;
    const pairedAt = new Date().toISOString();
    const payload = `${JSON.stringify({
      version: 1,
      deviceId,
      name: input.name?.trim() || pending.requestedName || host.name || remote.hostname,
      hostname: remote.hostname,
      platform: remote.platform,
      arch: remote.arch,
      credential,
      hub: process.env.RWMCP_DEVICE_ID?.trim() || 'remote-workstation-hub',
      pairedAt
    }, null, 2)}\n`;
    const writer = remote.family === 'windows' ? WINDOWS_CONFIG_COMMAND : POSIX_CONFIG_COMMAND;
    const written = await this.run(host, writer, payload, 15000);
    if (written.code !== 0) {
      throw new Error(`Remote paired-agent bootstrap failed for '${host.id}': ${written.stderr.trim() || `exit ${written.code}`}`);
    }
    const claimed = await this.store.claim(input.code, {
      deviceId,
      name: input.name?.trim() || pending.requestedName || host.name || remote.hostname,
      hostname: remote.hostname,
      platform: remote.platform,
      arch: remote.arch,
      version: this.serverVersion,
      capabilities: ['paired.identity', 'ssh.bootstrap'],
      bootstrapTransport: 'ssh',
      bootstrapHostId: host.id
    }, { deviceId, credential });
    return {
      device: claimed.device,
      remoteConfigPath: written.stdout.trim(),
      credentialDelivered: true
    };
  }
}

