import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export interface NativePowerPointValidationResult {
  ok: boolean;
  powerPointVersion?: string;
  slides?: number;
  shapes?: number;
  pdfPath?: string;
  error?: string;
}

export interface NativePowerPointAdapterOptions { scriptPath?: string; powershell?: string; timeoutMs?: number; }

async function runProcess(program: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(program, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = []; const stderr: Buffer[] = []; let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      if (process.platform === 'win32' && child.pid) { const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' }); killer.unref(); }
      else child.kill('SIGKILL');
      settled = true; reject(new Error(`POWERPOINT_COM_TIMEOUT: helper exceeded ${timeoutMs} ms.`));
    }, timeoutMs);
    child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk))); child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
    child.once('error', error => { if (settled) return; clearTimeout(timer); settled = true; reject(error); });
    child.once('exit', code => { if (settled) return; clearTimeout(timer); settled = true; resolve({ code, stdout: Buffer.concat(stdout).toString('utf8').trim(), stderr: Buffer.concat(stderr).toString('utf8').trim() }); });
  });
}

export class NativePowerPointAdapter {
  private readonly scriptPath: string; private readonly powershell: string; private readonly timeoutMs: number;
  constructor(options: NativePowerPointAdapterOptions = {}) {
    this.scriptPath = options.scriptPath ?? path.resolve('scripts/office/powerpoint-com.ps1');
    this.powershell = options.powershell ?? 'powershell.exe';
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }
  supported(platform = process.platform): boolean { return platform === 'win32'; }
  async validateAndRender(presentationPath: string, outputPdfPath: string, options: { exportPdf?: boolean } = {}): Promise<NativePowerPointValidationResult> {
    if (!this.supported()) throw new Error('POWERPOINT_COM_UNAVAILABLE: native PowerPoint automation is Windows-specific.');
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-powerpoint-native-'));
    const requestPath = path.join(tempRoot, `${randomUUID()}.json`);
    try {
      await fs.writeFile(requestPath, JSON.stringify({ action: 'validate-render', presentationPath, outputPdfPath, exportPdf: options.exportPdf ?? false }), 'utf8');
      const execution = await runProcess(this.powershell, ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', this.scriptPath, '-InputPath', requestPath], this.timeoutMs);
      if (execution.code !== 0 && !execution.stdout) throw new Error(`POWERPOINT_COM_FAILED: ${execution.stderr || `helper exited ${execution.code}`}`);
      let parsed: NativePowerPointValidationResult;
      try { parsed = JSON.parse(execution.stdout) as NativePowerPointValidationResult; }
      catch { throw new Error(`POWERPOINT_COM_PROTOCOL_ERROR: ${execution.stdout.slice(0, 512)} ${execution.stderr.slice(0, 512)}`); }
      if (!parsed.ok) throw new Error(`POWERPOINT_COM_FAILED: ${parsed.error ?? 'native PowerPoint rejected the presentation'}`);
      return parsed;
    } finally { await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {}); }
  }
}
