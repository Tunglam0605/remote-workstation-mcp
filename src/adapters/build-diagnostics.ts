import type { ProcessSnapshot } from '../model.js';
import { ProcessManager } from './process-manager.js';

export type DiagnosticSeverity = 'fatal' | 'error' | 'warning' | 'note';

export interface BuildDiagnostic {
  file?: string;
  line?: number;
  column?: number;
  severity: DiagnosticSeverity;
  code?: string;
  message: string;
  raw: string;
}

export interface BuildDiagnosticReport {
  processId: string;
  status: ProcessSnapshot['status'];
  exitCode: number | null;
  errorCount: number;
  warningCount: number;
  noteCount: number;
  diagnostics: BuildDiagnostic[];
  truncated: boolean;
}

function severityOf(value: string): DiagnosticSeverity {
  const normalized = value.toLowerCase();
  if (normalized === 'fatal error') return 'fatal';
  if (normalized === 'error') return 'error';
  if (normalized === 'warning') return 'warning';
  return 'note';
}

export function parseBuildDiagnostics(text: string, maxDiagnostics = 50): { diagnostics: BuildDiagnostic[]; truncated: boolean } {
  const diagnostics: BuildDiagnostic[] = [];
  const seen = new Set<string>();
  const limit = Math.max(1, Math.min(maxDiagnostics, 200));
  let truncated = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line) continue;

    let diagnostic: BuildDiagnostic | undefined;

    const gcc = line.match(/^(.*?):(\d+):(?:(\d+):)?\s*(fatal error|error|warning|note):\s*(.*)$/i);
    if (gcc) {
      diagnostic = {
        file: gcc[1],
        line: Number(gcc[2]),
        column: gcc[3] ? Number(gcc[3]) : undefined,
        severity: severityOf(gcc[4]),
        message: gcc[5],
        raw: line
      };
    }

    if (!diagnostic) {
      const keil = line.match(/^(.*?)\((\d+)(?:,(\d+))?\):\s*(fatal error|error|warning|note)\s*:\s*(?:#([0-9]+(?:-[A-Za-z])?)\s*:?\s*)?(.*)$/i);
      if (keil) {
        diagnostic = {
          file: keil[1],
          line: Number(keil[2]),
          column: keil[3] ? Number(keil[3]) : undefined,
          severity: severityOf(keil[4]),
          code: keil[5] ? `#${keil[5]}` : undefined,
          message: keil[6],
          raw: line
        };
      }
    }

    if (!diagnostic) {
      const keilLinker = line.match(/^(?:(.*?):\s*)?(fatal error|error|warning):\s*([A-Z]\d+[A-Z]?):\s*(.*)$/i);
      if (keilLinker) {
        diagnostic = {
          file: keilLinker[1] || undefined,
          severity: severityOf(keilLinker[2]),
          code: keilLinker[3],
          message: keilLinker[4],
          raw: line
        };
      }
    }

    if (!diagnostic) {
      const msvc = line.match(/^(.*?)\((\d+)(?:,(\d+))?\):\s*(fatal error|error|warning)\s*([A-Za-z]+\d+)?\s*:?\s*(.*)$/i);
      if (msvc) {
        diagnostic = {
          file: msvc[1],
          line: Number(msvc[2]),
          column: msvc[3] ? Number(msvc[3]) : undefined,
          severity: severityOf(msvc[4]),
          code: msvc[5] || undefined,
          message: msvc[6],
          raw: line
        };
      }
    }

    if (!diagnostic) {
      const cmake = line.match(/^CMake Error at (.*?):(\d+)(?: \((.*?)\))?:?\s*(.*)$/i);
      if (cmake) {
        diagnostic = {
          file: cmake[1],
          line: Number(cmake[2]),
          severity: 'error',
          code: cmake[3] || 'CMAKE',
          message: cmake[4] || 'CMake configuration error',
          raw: line
        };
      }
    }

    if (!diagnostic) continue;
    const key = `${diagnostic.file ?? ''}:${diagnostic.line ?? ''}:${diagnostic.column ?? ''}:${diagnostic.severity}:${diagnostic.code ?? ''}:${diagnostic.message}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (diagnostics.length >= limit) {
      truncated = true;
      continue;
    }
    diagnostics.push(diagnostic);
  }

  return { diagnostics, truncated };
}

export class BuildDiagnosticsAdapter {
  constructor(private readonly processes: ProcessManager) {}

  report(processId: string, maxDiagnostics = 50): BuildDiagnosticReport {
    const snapshot = this.processes.read(processId);
    const parsed = parseBuildDiagnostics(`${snapshot.stdout}\n${snapshot.stderr}`, maxDiagnostics);
    let errorCount = 0;
    let warningCount = 0;
    let noteCount = 0;
    for (const item of parsed.diagnostics) {
      if (item.severity === 'fatal' || item.severity === 'error') errorCount += 1;
      else if (item.severity === 'warning') warningCount += 1;
      else noteCount += 1;
    }
    return {
      processId,
      status: snapshot.status,
      exitCode: snapshot.exitCode,
      errorCount,
      warningCount,
      noteCount,
      diagnostics: parsed.diagnostics,
      truncated: parsed.truncated
    };
  }
}
