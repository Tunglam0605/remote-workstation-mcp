import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export interface NativeExcelValidationResult {
  ok: boolean;
  excelVersion?: string;
  sheets?: number;
  formulaErrors?: number;
  calculationState?: number;
  pdfPath?: string;
  error?: string;
}

export interface NativeExcelAdapterOptions { scriptPath?: string; powershell?: string; timeoutMs?: number; }

async function runProcess(program: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(program, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = []; const stderr: Buffer[] = []; let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      if (process.platform === 'win32' && child.pid) { const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' }); killer.unref(); }
      else child.kill('SIGKILL');
      settled = true; reject(new Error(`EXCEL_COM_TIMEOUT: helper exceeded ${timeoutMs} ms.`));
    }, timeoutMs);
    child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk))); child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
    child.once('error', error => { if (settled) return; clearTimeout(timer); settled = true; reject(error); });
    child.once('exit', code => { if (settled) return; clearTimeout(timer); settled = true; resolve({ code, stdout: Buffer.concat(stdout).toString('utf8').trim(), stderr: Buffer.concat(stderr).toString('utf8').trim() }); });
  });
}

export class NativeExcelAdapter {
  private readonly scriptPath: string; private readonly powershell: string; private readonly timeoutMs: number;
  constructor(options: NativeExcelAdapterOptions = {}) {
    this.scriptPath = options.scriptPath ?? path.resolve('scripts/office/excel-com.ps1');
    this.powershell = options.powershell ?? 'powershell.exe';
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }
  supported(platform = process.platform): boolean { return platform === 'win32'; }
  async validateAndRender(workbookPath: string, outputPdfPath: string, options: { recalculate?: boolean; exportPdf?: boolean } = {}): Promise<NativeExcelValidationResult> {
    if (!this.supported()) throw new Error('EXCEL_COM_UNAVAILABLE: native Excel automation is Windows-specific.');
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-excel-native-'));
    const requestPath = path.join(tempRoot, `${randomUUID()}.json`);
    try {
      await fs.writeFile(requestPath, JSON.stringify({ action: 'validate-render', workbookPath, outputPdfPath, recalculate: options.recalculate ?? true, exportPdf: options.exportPdf ?? false }), 'utf8');
      const execution = await runProcess(this.powershell, ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', this.scriptPath, '-InputPath', requestPath], this.timeoutMs);
      if (execution.code !== 0 && !execution.stdout) throw new Error(`EXCEL_COM_FAILED: ${execution.stderr || `helper exited ${execution.code}`}`);
      let parsed: NativeExcelValidationResult;
      try { parsed = JSON.parse(execution.stdout) as NativeExcelValidationResult; }
      catch { throw new Error(`EXCEL_COM_PROTOCOL_ERROR: ${execution.stdout.slice(0, 512)} ${execution.stderr.slice(0, 512)}`); }
      if (!parsed.ok) throw new Error(`EXCEL_COM_FAILED: ${parsed.error ?? 'native Excel rejected the workbook'}`);
      return parsed;
    } finally { await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {}); }
  }
}
