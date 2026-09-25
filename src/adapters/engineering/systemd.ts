import os from 'node:os';
import { PolicyEngine } from '../../policy.js';
import { PathGuard } from '../../security/path-guard.js';
import { EngineeringCommandRunner } from './command-runner.js';
import { resolveFirstExecutable } from './executable-resolver.js';

const UNIT_RE = /^[A-Za-z0-9@_.:-]+\.(service|timer|socket|path|target)$/;

function validateUnit(unit: string): string {
  const value = unit.trim();
  if (!value || value.length > 160 || !UNIT_RE.test(value)) {
    throw new Error('systemd unit must be an explicit service/timer/socket/path/target name.');
  }
  return value;
}

function parseProperties(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const index = line.indexOf('=');
    if (index <= 0) continue;
    result[line.slice(0, index)] = line.slice(index + 1);
  }
  return result;
}

function parseJournalEntries(text: string) {
  return text.split(/\r?\n/).filter(Boolean).flatMap(line => {
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      const message = typeof record.MESSAGE === 'string'
        ? record.MESSAGE.slice(0, 4096)
        : record.MESSAGE === undefined ? '' : JSON.stringify(record.MESSAGE).slice(0, 4096);
      return [{
        realtimeTimestamp: typeof record.__REALTIME_TIMESTAMP === 'string' ? record.__REALTIME_TIMESTAMP : undefined,
        priority: typeof record.PRIORITY === 'string' ? record.PRIORITY : undefined,
        identifier: typeof record.SYSLOG_IDENTIFIER === 'string' ? record.SYSLOG_IDENTIFIER : undefined,
        pid: typeof record._PID === 'string' ? record._PID : undefined,
        invocationId: typeof record._SYSTEMD_INVOCATION_ID === 'string' ? record._SYSTEMD_INVOCATION_ID : undefined,
        message
      }];
    } catch {
      return [];
    }
  });
}

export class SystemdAdapter {
  constructor(
    private readonly policy: PolicyEngine,
    private readonly paths: PathGuard,
    private readonly runner: EngineeringCommandRunner
  ) {}

  private assertSupportedHost(): void {
    if (os.platform() !== 'linux') throw new Error('systemd workflows are supported on Linux hosts only.');
  }

  private async systemctl(): Promise<string> {
    const resolved = await resolveFirstExecutable(['systemctl']);
    if (!resolved) throw new Error('systemctl is unavailable.');
    return resolved.path;
  }

  async diagnostics(
    workspace: string,
    unitRaw: string,
    cwdRelative = '.',
    user = false,
    journalLines = 100
  ) {
    this.policy.assertEngineeringEnabled();
    this.assertSupportedHost();
    const unit = validateUnit(unitRaw);
    if (!Number.isInteger(journalLines) || journalLines < 1 || journalLines > 1000) {
      throw new Error('journalLines must be in range 1..1000.');
    }
    const cwd = await this.paths.resolveExisting(workspace, cwdRelative);
    const systemctl = await this.systemctl();
    const prefix = user ? ['--user'] : [];
    const show = await this.runner.run(systemctl, [
      ...prefix,
      'show',
      unit,
      '--no-pager',
      '--property=LoadState,ActiveState,SubState,UnitFileState,Result,MainPID,ExecMainCode,ExecMainStatus,NRestarts,MemoryCurrent,CPUUsageNSec,TasksCurrent,InvocationID,ExecMainStartTimestampMonotonic,ActiveEnterTimestampMonotonic,FragmentPath'
    ], cwd, 15_000);
    if (show.exitCode !== 0 || show.timedOut) {
      throw new Error(`systemctl show ${unit} failed: ${show.stderr || show.stdout || `exit=${show.exitCode}`}`);
    }

    const journalctl = await resolveFirstExecutable(['journalctl']);
    let journal: {
      available: boolean;
      state?: 'ok' | 'degraded';
      format?: 'json';
      entries?: ReturnType<typeof parseJournalEntries>;
      stdout?: string;
      stderr?: string;
      exitCode?: number | null;
    } = { available: false };
    if (journalctl) {
      const journalArgs = user
        ? ['--user-unit', unit, '-n', String(journalLines), '--no-pager', '--output=json']
        : ['-u', unit, '-n', String(journalLines), '--no-pager', '--output=json'];
      const result = await this.runner.run(journalctl.path, journalArgs, cwd, 15_000);
      journal = {
        available: true,
        state: !result.timedOut && result.exitCode === 0 ? 'ok' : 'degraded',
        format: 'json',
        entries: parseJournalEntries(result.stdout),
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode
      };
    }

    return {
      unit,
      scope: user ? 'user' as const : 'system' as const,
      properties: parseProperties(show.stdout),
      journal
    };
  }

  async restart(
    workspace: string,
    unitRaw: string,
    cwdRelative = '.',
    user = false,
    journalLines = 100
  ) {
    this.assertSupportedHost();
    const unit = validateUnit(unitRaw);
    this.policy.assertSystemdRestart(unit);
    const cwd = await this.paths.resolveExisting(workspace, cwdRelative);
    const systemctl = await this.systemctl();
    const result = await this.runner.run(systemctl, [...(user ? ['--user'] : []), 'restart', unit], cwd, 60_000);
    if (result.exitCode !== 0 || result.timedOut) {
      throw new Error(`systemctl restart ${unit} failed: ${result.stderr || result.stdout || `exit=${result.exitCode}`}`);
    }
    const diagnostics = await this.diagnostics(workspace, unit, cwdRelative, user, journalLines);
    return { unit, restart: result, diagnostics };
  }
}
