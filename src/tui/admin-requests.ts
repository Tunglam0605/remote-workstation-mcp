import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { NodeInterlockStore } from '../node-interlock.js';
import {
  approveAdminRequest,
  denyAdminRequest,
  finishAdminRequest,
  listAdminRequests,
  markAdminRequestRunning,
  readAdminRequest,
  type AdminRequest
} from '../privileged/approval-store.js';
import { setupConfigDir } from '../setup/settings.js';

const LINUX_SYSTEMCTL = '/usr/bin/systemctl';
const LINUX_REBOOT_ARGS = ['--no-block', 'reboot'] as const;

export interface TuiAdminOptions {
  platform?: NodeJS.Platform;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  runPrivileged?: (program: string, args: string[], env: NodeJS.ProcessEnv) => Promise<{ code: number; stdout: string; stderr: string }>;
}

function platformOf(options: TuiAdminOptions): NodeJS.Platform {
  return options.platform ?? process.platform;
}

function homeOf(options: TuiAdminOptions): string {
  return options.homeDir ?? os.homedir();
}

function envOf(options: TuiAdminOptions): NodeJS.ProcessEnv {
  return options.env ?? process.env;
}

function defaultRunPrivileged(program: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      env,
      stdio: ['inherit', 'inherit', 'inherit']
    });
    child.once('error', reject);
    child.once('close', code => resolve({ code: code ?? 1, stdout: '', stderr: '' }));
  });
}

export function isLinuxHostRebootRequest(request: AdminRequest): boolean {
  return request.program === LINUX_SYSTEMCTL
    && request.args.length === LINUX_REBOOT_ARGS.length
    && request.args.every((value, index) => value === LINUX_REBOOT_ARGS[index])
    && !request.cwd;
}

export async function listPendingTuiAdminRequests(): Promise<AdminRequest[]> {
  return (await listAdminRequests()).filter(request => request.state === 'pending');
}

async function assertRebootInterlockClear(options: TuiAdminOptions): Promise<void> {
  const platform = platformOf(options);
  const homeDir = homeOf(options);
  const env = envOf(options);
  const base = setupConfigDir({ platform, homeDir, env });
  const interlocks = new NodeInterlockStore('owner-local-host-reboot', {
    file: path.join(base, 'runtime', 'work-session-interlocks.json')
  });
  await interlocks.reconcileStale();
  const active = await interlocks.listActive();
  if (active.length > 0) {
    throw new Error(`NODE_BUSY: ${active.length} active Work Session workflow interlock(s) prevent host reboot.`);
  }
}

export async function approveLinuxHostRebootRequest(
  requestId: string,
  expectedCommandHash: string,
  options: TuiAdminOptions = {}
): Promise<AdminRequest> {
  if (platformOf(options) !== 'linux') {
    throw new Error('TUI host reboot approval currently supports Linux only.');
  }

  const pending = await readAdminRequest(requestId);
  if (!isLinuxHostRebootRequest(pending)) {
    throw new Error('TUI Linux approval is restricted to the typed host reboot request.');
  }

  await assertRebootInterlockClear(options);
  const approved = await approveAdminRequest(requestId, expectedCommandHash);
  if (!isLinuxHostRebootRequest(approved.request)) {
    throw new Error('Approved request no longer matches the typed host reboot action.');
  }

  await markAdminRequestRunning(requestId);
  const runner = options.runPrivileged ?? defaultRunPrivileged;
  let execution: { code: number; stdout: string; stderr: string };
  try {
    execution = await runner(
      'sudo',
      ['-k', '--', LINUX_SYSTEMCTL, ...LINUX_REBOOT_ARGS],
      envOf(options)
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finishAdminRequest(requestId, { exitCode: null, error: message }).catch(() => undefined);
    throw error;
  }

  const output = [execution.stdout, execution.stderr].filter(Boolean).join('\n').trim();
  const finished = await finishAdminRequest(requestId, {
    exitCode: execution.code,
    output,
    ...(execution.code === 0 ? {} : { error: output || `sudo/systemctl exited with code ${execution.code}.` })
  });
  if (execution.code !== 0) {
    throw new Error(finished.result?.error || `Host reboot request failed with code ${execution.code}.`);
  }
  return finished;
}

export async function denyTuiAdminRequest(requestId: string): Promise<AdminRequest> {
  return await denyAdminRequest(requestId);
}

export function linuxHostRebootCommand(): { program: string; args: string[] } {
  return { program: LINUX_SYSTEMCTL, args: [...LINUX_REBOOT_ARGS] };
}
