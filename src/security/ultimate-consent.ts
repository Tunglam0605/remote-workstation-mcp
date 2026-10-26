import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as z from 'zod/v4';
import { readRuntimeEpoch } from './ultimate-runtime-epoch.js';

const operations = ['build', 'test', 'workspace_add', 'transfer', 'artifact_verify'] as const;
const identifier = z.string().regex(/^[A-Za-z0-9._-]{1,128}$/);
const scopeSchema = z.object({
  operations: z.array(z.enum(operations)).min(1).max(5),
  workspaces: z.array(identifier).min(1).max(32),
  profileIds: z.array(identifier).max(32),
  transferGrantIds: z.array(identifier).max(32),
  workSessionId: identifier.optional()
}).strict();
const activationSchema = z.object({
  nodeId: identifier,
  principalId: identifier,
  durationMinutes: z.union([z.literal(30), z.literal(60), z.literal(120), z.literal(240)]),
  scope: scopeSchema
}).strict();
const recordSchema = activationSchema.extend({
  id: z.uuid(),
  runtimeEpoch: identifier,
  issuedAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
  issuedUptimeMs: z.number().nonnegative().finite()
});

export type UltimateOperation = typeof operations[number];
export type UltimateScope = z.infer<typeof scopeSchema>;
export type UltimateActivation = z.infer<typeof activationSchema>;

export interface UltimateActionContext {
  nodeId: string;
  principalId: string;
  operation: UltimateOperation;
  workspaceId: string;
  profileId?: string;
  grantId?: string;
  workSessionId?: string;
}

export interface UltimateStatus {
  active: boolean;
  state: 'active' | 'inactive' | 'expired' | 'revoked';
  remainingSeconds: number;
  issuedAt?: string;
  expiresAt?: string;
  scope?: UltimateScope;
}

export interface UltimateLifecycleEvent {
  action: 'activated' | 'revoked';
  happenedAt: string;
  consentId?: string;
  nodeId?: string;
  durationMinutes?: number;
  operations?: UltimateOperation[];
}

interface Clock {
  wallMs(): number;
  uptimeMs(): number;
}

interface Options {
  filePath: string;
  epochPath: string;
  clock?: Clock;
}

const defaultClock: Clock = {
  wallMs: () => Date.now(),
  uptimeMs: () => os.uptime() * 1000
};

export class UltimateConsentManager {
  private readonly filePath: string;
  private readonly epochPath: string;
  private readonly revokedPath: string;
  private readonly auditPath: string;
  private readonly clock: Clock;

  constructor(options: Options) {
    this.filePath = path.resolve(options.filePath);
    this.epochPath = path.resolve(options.epochPath);
    this.revokedPath = `${this.filePath}.revoked`;
    this.auditPath = `${this.filePath}.audit.jsonl`;
    this.clock = options.clock ?? defaultClock;
  }

  private async audit(event: UltimateLifecycleEvent): Promise<void> {
    await fs.mkdir(path.dirname(this.auditPath), { recursive: true });
    await fs.appendFile(this.auditPath, `${JSON.stringify(event)}\n`, { mode: 0o600, flag: 'a' });
  }

  async recentEvents(): Promise<UltimateLifecycleEvent[]> {
    try {
      const handle = await fs.open(this.auditPath, 'r');
      try {
        const size = (await handle.stat()).size;
        const start = Math.max(0, size - 64 * 1024);
        const bytes = Buffer.alloc(size - start);
        await handle.read(bytes, 0, bytes.length, start);
        const lines = bytes.toString('utf8').split('\n');
        if (start > 0) lines.shift(); // truncated first record
        return lines.filter(Boolean).slice(-20).flatMap(line => {
          try {
            const value = JSON.parse(line) as UltimateLifecycleEvent;
            return value.action === 'activated' || value.action === 'revoked' ? [value] : [];
          } catch { return []; }
        });
      } finally { await handle.close(); }
    } catch { return []; }
  }

  private async readRecord(): Promise<z.infer<typeof recordSchema> | undefined> {
    try {
      return recordSchema.parse(JSON.parse(await fs.readFile(this.filePath, 'utf8')));
    } catch {
      return undefined;
    }
  }

  private async validRecord() {
    const record = await this.readRecord();
    if (!record) return undefined;
    const currentEpoch = await readRuntimeEpoch(this.epochPath);
    if (!currentEpoch || currentEpoch !== record.runtimeEpoch) return undefined;
    const nowWall = this.clock.wallMs();
    const nowUptime = this.clock.uptimeMs();
    const durationMs = record.durationMinutes * 60_000;
    if (
      !Number.isFinite(nowWall) || !Number.isFinite(nowUptime) ||
      nowWall < Date.parse(record.issuedAt) - 60_000 ||
      nowWall >= Date.parse(record.expiresAt) ||
      nowUptime < record.issuedUptimeMs ||
      nowUptime >= record.issuedUptimeMs + durationMs
    ) return undefined;
    const remainingMs = Math.min(
      Date.parse(record.expiresAt) - nowWall,
      record.issuedUptimeMs + durationMs - nowUptime
    );
    return { record, remainingSeconds: Math.max(0, Math.ceil(remainingMs / 1000)) };
  }

  async activate(rawInput: UltimateActivation): Promise<UltimateStatus> {
    if (![30, 60, 120, 240].includes(rawInput?.durationMinutes)) {
      throw new Error('Ultimate durationMinutes must be 30, 60, 120 or 240.');
    }
    const input = activationSchema.parse(rawInput);
    if (await this.validRecord()) {
      throw new Error('Ultimate consent is already active. Revoke before a new owner activation.');
    }
    const runtimeEpoch = await readRuntimeEpoch(this.epochPath);
    if (!runtimeEpoch) throw new Error('The RWMCP runtime is not available for Ultimate activation.');
    const issuedMs = this.clock.wallMs();
    const issuedUptimeMs = this.clock.uptimeMs();
    if (!Number.isFinite(issuedMs) || !Number.isFinite(issuedUptimeMs) || issuedUptimeMs < 0) {
      throw new Error('Cannot establish a trustworthy Ultimate consent clock.');
    }
    const record = recordSchema.parse({
      ...input,
      id: crypto.randomUUID(),
      runtimeEpoch,
      issuedAt: new Date(issuedMs).toISOString(),
      expiresAt: new Date(issuedMs + input.durationMinutes * 60_000).toISOString(),
      issuedUptimeMs
    });
    const temporary = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      await fs.writeFile(temporary, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, this.filePath);
      await fs.chmod(this.filePath, 0o600);
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
    await fs.rm(this.revokedPath, { force: true });
    await this.audit({
      action: 'activated', happenedAt: record.issuedAt, consentId: record.id,
      nodeId: record.nodeId, durationMinutes: record.durationMinutes,
      operations: record.scope.operations
    });
    return await this.status();
  }

  async status(): Promise<UltimateStatus> {
    const valid = await this.validRecord();
    if (valid) {
      return {
        active: true,
        state: 'active',
        remainingSeconds: valid.remainingSeconds,
        issuedAt: valid.record.issuedAt,
        expiresAt: valid.record.expiresAt,
        scope: valid.record.scope
      };
    }
    const present = await this.readRecord();
    if (present) return { active: false, state: 'expired', remainingSeconds: 0 };
    const revoked = await fs.access(this.revokedPath).then(() => true).catch(() => false);
    return { active: false, state: revoked ? 'revoked' : 'inactive', remainingSeconds: 0 };
  }

  async revoke(): Promise<void> {
    const previous = await this.readRecord();
    await fs.rm(this.filePath, { force: true });
    const happenedAt = new Date(this.clock.wallMs()).toISOString();
    await fs.writeFile(this.revokedPath, JSON.stringify({ happenedAt }), { mode: 0o600 });
    await this.audit({ action: 'revoked', happenedAt, consentId: previous?.id, nodeId: previous?.nodeId });
  }

  async assertAllowed(action: UltimateActionContext): Promise<void> {
    const valid = await this.validRecord();
    if (!valid) throw new Error('Ultimate consent is inactive or expired.');
    const { record } = valid;
    const scope = record.scope;
    if (
      action.nodeId !== record.nodeId ||
      action.principalId !== record.principalId ||
      !scope.operations.includes(action.operation) ||
      !scope.workspaces.includes(action.workspaceId) ||
      (scope.workSessionId !== undefined && action.workSessionId !== scope.workSessionId) ||
      (action.profileId !== undefined && !scope.profileIds.includes(action.profileId)) ||
      (['build', 'test'].includes(action.operation) && (!action.profileId || !scope.profileIds.includes(action.profileId))) ||
      (action.grantId !== undefined && !scope.transferGrantIds.includes(action.grantId)) ||
      (action.operation === 'transfer' && (!action.grantId || !scope.transferGrantIds.includes(action.grantId)))
    ) {
      throw new Error('Ultimate operation denied by exact owner-approved scope.');
    }
  }
}
