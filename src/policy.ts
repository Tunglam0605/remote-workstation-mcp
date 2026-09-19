import path from 'node:path';
import type { PermissionLease, PermissionMode, PolicyConfig, WorkspaceConfig } from './model.js';

const MODE_RANK: Record<PermissionMode, number> = {
  read_only: 0,
  workspace: 1,
  elevated: 2,
  full_control: 3
};

type ClientIdSource = string | (() => string);

export class PolicyEngine {
  constructor(
    readonly config: PolicyConfig,
    private readonly lease?: PermissionLease,
    private readonly clientIdSource: ClientIdSource = 'unknown'
  ) {}

  private clientId(): string {
    return typeof this.clientIdSource === 'function' ? this.clientIdSource() : this.clientIdSource;
  }

  private activeLease(now = new Date()): PermissionLease | undefined {
    if (!this.lease) return undefined;
    const expires = Date.parse(this.lease.expiresAt);
    if (!Number.isFinite(expires) || expires <= now.getTime()) return undefined;
    if (this.lease.clientId && this.lease.clientId !== this.clientId()) return undefined;
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
      clientId: this.clientId(),
      lease: active ? {
        mode: active.mode,
        issuedAt: active.issuedAt,
        expiresAt: active.expiresAt,
        reason: active.reason,
        clientId: active.clientId
      } : undefined,
      leasePresentButInactive: Boolean(this.lease && !active),
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
    if (this.effectiveMode() === 'read_only') throw new Error('Process execution is disabled in read_only mode.');
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
      throw new Error('This action requires effective full_control mode (owner-selected Full Access or a valid owner lease).');
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

  legacyRemoteControlEnabled(): boolean {
    return this.config.legacyRemoteControl?.enabled ?? false;
  }

  assertLegacyRemoteControl(): void {
    if (!this.legacyRemoteControlEnabled()) {
      throw new Error('Legacy node-to-node SSH/device control is disabled by local owner policy (legacyRemoteControl.enabled=false).');
    }
    if (this.effectiveMode() === 'read_only') {
      throw new Error('Legacy node-to-node remote control is disabled in read_only mode.');
    }
  }

  assertEngineeringEnabled(): void {
    if (!(this.config.engineering?.enabled ?? true)) {
      throw new Error('Engineering tools are disabled by local owner policy (engineering.enabled=false).');
    }
  }

  assertEngineeringExecute(): void {
    this.assertEngineeringEnabled();
    if (this.effectiveMode() === 'read_only') {
      throw new Error('Engineering execution is disabled in read_only mode.');
    }
  }

  assertHardwareMutation(): void {
    this.assertEngineeringExecute();
    if (this.effectiveMode() === 'workspace' && !(this.config.engineering?.allowHardwareMutationInWorkspace ?? false)) {
      throw new Error('Hardware mutation requires elevated/full_control mode or engineering.allowHardwareMutationInWorkspace=true.');
    }
  }

  assertSerialWrite(): void {
    this.assertEngineeringExecute();
    if (this.effectiveMode() === 'workspace' && !(this.config.engineering?.allowSerialWriteInWorkspace ?? false)) {
      throw new Error('Serial write requires elevated/full_control mode or engineering.allowSerialWriteInWorkspace=true.');
    }
  }

  assertContainerCapability(capability: 'lifecycle' | 'exec' | 'image_build', highRisk = false): void {
    this.assertEngineeringExecute();
    const mode = this.effectiveMode();
    const config = this.config.containers;
    if (mode === 'workspace') {
      const allowed = capability === 'lifecycle'
        ? (config?.allowLifecycleInWorkspace ?? false)
        : capability === 'exec'
          ? (config?.allowExecInWorkspace ?? false)
          : (config?.allowImageBuildInWorkspace ?? false);
      if (!allowed) {
        throw new Error(`Container capability '${capability}' requires elevated/full_control mode or the matching containers.*InWorkspace owner policy.`);
      }
    }
    if (highRisk) {
      this.assertFullControl();
      if (!(config?.allowHighRisk ?? false)) {
        throw new Error('High-risk container operation is disabled by local owner policy (containers.allowHighRisk=false).');
      }
    }
  }
}
