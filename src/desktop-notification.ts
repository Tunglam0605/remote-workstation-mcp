import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';

export type DesktopNotificationKind = 'info' | 'success' | 'warning' | 'error' | 'approval';

export interface DesktopNotification {
  title: string;
  body: string;
  kind?: DesktopNotificationKind;
}

export interface DesktopNotificationResult {
  delivered: boolean;
  reason?: 'unsupported-platform' | 'invalid-payload' | 'spawn-failed';
}

export interface DesktopNotificationServiceOptions {
  platform?: NodeJS.Platform;
  scriptPath?: string;
  spawnProcess?: typeof spawn;
}

function bounded(value: string, max: number): string {
  return value.trim().replace(/\s+/g, ' ').slice(0, max);
}

export class DesktopNotificationService {
  private readonly platform: NodeJS.Platform;
  private readonly scriptPath: string;
  private readonly spawnProcess: typeof spawn;

  constructor(
    private readonly version: string,
    options: DesktopNotificationServiceOptions = {}
  ) {
    this.platform = options.platform ?? process.platform;
    this.scriptPath = options.scriptPath ?? path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      'scripts',
      'show-windows-notification.ps1'
    );
    this.spawnProcess = options.spawnProcess ?? spawn;
  }

  async notify(notification: DesktopNotification): Promise<DesktopNotificationResult> {
    if (this.platform !== 'win32') return { delivered: false, reason: 'unsupported-platform' };

    const title = bounded(notification.title, 96);
    const body = bounded(notification.body, 320);
    if (!title || !body) return { delivered: false, reason: 'invalid-payload' };

    const payload = Buffer.from(JSON.stringify({
      app: `Remote Workstation MCP v${this.version}`,
      title,
      body,
      kind: notification.kind ?? 'info'
    }), 'utf8').toString('base64');

    try {
      const child = this.spawnProcess('powershell.exe', [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Sta',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        this.scriptPath,
        '-PayloadBase64',
        payload
      ], {
        shell: false,
        detached: true,
        windowsHide: true,
        stdio: 'ignore'
      }) as ChildProcess;
      child.once('error', () => undefined);
      child.unref();
      return { delivered: true };
    } catch {
      return { delivered: false, reason: 'spawn-failed' };
    }
  }
}
