import fs from 'node:fs/promises';
import path from 'node:path';

export interface AuditActor {
  clientId: string;
  clientType: string;
}

export class AuditLogger {
  constructor(
    private readonly filePath: string,
    private readonly actor: AuditActor = { clientId: 'unknown', clientType: 'mcp-client' }
  ) {}

  async record(tool: string, ok: boolean, durationMs: number, workspace?: string, error?: unknown): Promise<void> {
    const entry = {
      ts: new Date().toISOString(),
      actor: this.actor,
      tool,
      workspace,
      ok,
      durationMs,
      error: ok ? undefined : String(error instanceof Error ? error.message : error)
    };
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.appendFile(this.filePath, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
}

export async function audited<T>(audit: AuditLogger, tool: string, workspace: string | undefined, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    const result = await fn();
    await audit.record(tool, true, Date.now() - started, workspace);
    return result;
  } catch (error) {
    await audit.record(tool, false, Date.now() - started, workspace, error);
    throw error;
  }
}
