import path from 'node:path';
import type { PolicyConfig, WorkspaceConfig } from './model.js';

export class PolicyEngine {
  constructor(readonly config: PolicyConfig) {}

  workspace(id: string): WorkspaceConfig {
    const ws = this.config.workspaces.find(item => item.id === id);
    if (!ws) throw new Error(`Workspace '${id}' is not authorized.`);
    return ws;
  }

  assertWrite(workspaceId: string): void {
    const ws = this.workspace(workspaceId);
    if (this.config.mode === 'read_only' || ws.readOnly) {
      throw new Error(`Workspace '${workspaceId}' is read-only.`);
    }
  }

  assertExecute(program: string): void {
    if (this.config.mode === 'read_only') throw new Error('Process execution is disabled in read_only mode.');
    const name = path.basename(program).toLowerCase();
    const allowed = this.config.process.allowExecutables.some(item => item.toLowerCase() === name);
    if (!allowed) throw new Error(`Executable '${program}' is not in process.allowExecutables.`);
  }
}
