import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export interface NativeWordValidationResult {
  ok: boolean;
  wordVersion?: string;
  pages?: number;
  equations?: number;
  pdfPath?: string;
  wordPid?: number;
  error?: string;
}

export interface NativeWordAdapterOptions {
  scriptPath?: string;
  powershell?: string;
  timeoutMs?: number;
}

async function runProcess(program: string, args: string[], timeoutMs: number): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return await new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill();
      settled = true;
      reject(new Error(`WORD_COM_TIMEOUT: helper exceeded ${timeoutMs} ms.`));
    }, timeoutMs);
    child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
    child.once('error', error => {
      if (settled) return;
      clearTimeout(timer);
      settled = true;
      reject(error);
    });
    child.once('exit', code => {
      if (settled) return;
      clearTimeout(timer);
      settled = true;
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString('utf8').trim(),
        stderr: Buffer.concat(stderr).toString('utf8').trim()
      });
    });
  });
}

export class NativeWordAdapter {
  private readonly scriptPath: string;
  private readonly powershell: string;
  private readonly timeoutMs: number;

  constructor(options: NativeWordAdapterOptions = {}) {
    this.scriptPath = options.scriptPath ?? path.resolve('scripts/office/word-com.ps1');
    this.powershell = options.powershell ?? 'powershell.exe';
    this.timeoutMs = options.timeoutMs ?? 45_000;
  }

  supported(platform = process.platform): boolean {
    return platform === 'win32';
  }

  async validateAndRender(
    documentPath: string,
    outputPdfPath: string,
    options: { exportPdf?: boolean } = {}
  ): Promise<NativeWordValidationResult> {
    if (!this.supported()) {
      throw new Error('WORD_COM_UNAVAILABLE: native Word automation is Windows-specific.');
    }

    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-word-native-'));
    const requestPath = path.join(tempRoot, `${randomUUID()}.json`);
    try {
      await fs.writeFile(requestPath, JSON.stringify({
        action: 'validate-render',
        documentPath,
        outputPdfPath,
        exportPdf: options.exportPdf ?? true
      }), 'utf8');
      const execution = await runProcess(
        this.powershell,
        ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', this.scriptPath, '-InputPath', requestPath],
        this.timeoutMs
      );
      if (execution.code !== 0 && !execution.stdout) {
        throw new Error(`WORD_COM_FAILED: ${execution.stderr || `helper exited ${execution.code}`}`);
      }

      let parsed: NativeWordValidationResult;
      try {
        parsed = JSON.parse(execution.stdout) as NativeWordValidationResult;
      } catch {
        throw new Error(
          `WORD_COM_PROTOCOL_ERROR: ${execution.stdout.slice(0, 512)} ${execution.stderr.slice(0, 512)}`
        );
      }
      if (!parsed.ok) {
        throw new Error(`WORD_COM_FAILED: ${parsed.error ?? 'native Word rejected the document'}`);
      }
      return parsed;
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    }
  }
}
