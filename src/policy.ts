import path from 'node:path';
import type { PermissionLease, PermissionMode, PolicyConfig, WorkspaceConfig } from './model.js';

const MODE_RANK: Record<PermissionMode, number> = {
  read_only: 0,
  workspace: 1,
  elevated: 2,
  full_control: 3
};

export class PolicyEngine {
  constructor(readonly config: PolicyConfig, private readonly lease?: PermissionLease) {}

  private activeLease(now = new Date()): PermissionLease | undefined {
    if (!this.lease) return undefined;
    const expires = Date.parse(this.lease.expiresAt);
    if (!Number.isFinite(expires) || expires <= now.getTime()) return undefined;
    return this.lease;
  }

  effectiveMode(now = new Date()): PermissionMode {
    const active = this.activeLease(now);
    if (!active) return this.config.mode;
    return MODE_RANK[active.mode] > MODE_RANK[this.config.mode] ? active.mode : this.config.mode;
  }

  status(now = new Date()) {
    const active = this.activeLease(now);
    return {
      configuredMode: this.config.mode,
      effectiveMode: this.effectiveMode(now),
      lease: active ? {
        mode: active.mode,
        issuedAt: active.issuedAt,
        expiresAt: active.expiresAt,
        reason: active.reason
      } : undefined,
      fullControlGates: {
        rawShell: this.config.fullControl?.allowRawShell ?? false,
        hostFilesystem: this.config.fullControl?.allowHostFilesystem ?? false,
        sudo: this.config.privileged?.allowSudo ?? false
      }
    };
  }

  workspace(id: string): WorkspaceConfig {
    const ws = this.config.workspaces.find(item => item.id === id);
    if (!ws) throw new Error(`Workspace '${id}' is not authorized.`);
    return ws;
  }

  assertWrite(workspaceId: string): void {
    const ws = this.workspace(workspaceId);
    if (this.effectiveMode() === 'read_only' || ws.readOnly) {
      throw new Error(`Workspace '${workspaceId}' is read-only.`);
    }
  }

  assertExecute(program: string): void {
    const mode = this.effectiveMode();
    if (mode === 'read_only') throw new Error('Process execution is disabled in read_only mode.');
    if (mode === 'full_control') return;
    const name = path.basename(program).toLowerCase();
    const allowed = this.config.process.allowExecutables.some(item => path.basename(item).toLowerCase() === name);
    if (!allowed) throw new Error(`Executable '${program}' is not in process.allowExecutables.`);
  }

  assertElevated(): void {
    if (MODE_RANK[this.effectiveMode()] < MODE_RANK.elevated) {
      throw new Error('This action requires an active elevated or full-control owner lease.');
    }
  }

  assertFullControl(): void {
    if (this.effectiveMode() !== 'full_control') {
      throw new Error('This action requires an active full-control owner lease.');
    }
  }

  assertRawShell(): void {
    this.assertFullControl();
    if (!(this.config.fullControl?.allowRawShell ?? false)) {
      throw new Error('Raw shell is disabled by local owner policy (fullControl.allowRawShell=false).');
    }
  }

  assertHostFilesystem(): void {
    this.assertFullControl();
    if (!(this.config.fullControl?.allowHostFilesystem ?? false)) {
      throw new Error('Host filesystem access is disabled by local owner policy (fullControl.allowHostFilesystem=false).');
    }
  }

  assertSudo(): void {
    this.assertFullControl();
    if (!(this.config.privileged?.allowSudo ?? false)) {
      throw new Error('sudo/admin execution is disabled by local owner policy (privileged.allowSudo=false).');
    }
  }
}
