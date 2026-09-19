import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { QualityObservationRecord } from './quality-learning.js';
import { setupConfigDir } from './setup/settings.js';

export type OwnerQualityDecisionKind = 'approved' | 'rejected' | 'revoked';

export interface OwnerQualityDecisionRecord {
  version: 1;
  id: string;
  observationId: string;
  observationDigest: string;
  decision: OwnerQualityDecisionKind;
  reason?: string;
  createdAt: string;
}

interface OwnerQualityDecisionFileV1 {
  version: 1;
  decisions: OwnerQualityDecisionRecord[];
}

export interface OwnerQualityReviewStoreOptions {
  file?: string;
  now?: () => Date;
  maxRecords?: number;
}

function boundedReason(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  return normalized.slice(0, 512);
}

export function qualityObservationDigest(observation: QualityObservationRecord): string {
  const canonical = {
    version: observation.version,
    id: observation.id,
    principalId: observation.principalId,
    workSessionId: observation.workSessionId,
    workflowRunId: observation.workflowRunId,
    workspace: observation.workspace,
    projectPath: observation.projectPath,
    workflow: observation.workflow,
    outcome: observation.outcome,
    completionSource: observation.completionSource,
    explicitOutcome: observation.explicitOutcome,
    durationMs: observation.durationMs,
    environmentHash: observation.environment.hash,
    candidateState: observation.candidateState,
    promotionState: observation.promotionState,
    active: observation.active,
    createdAt: observation.createdAt
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export class OwnerQualityReviewStore {
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly file: string;
  private readonly now: () => Date;
  private readonly maxRecords: number;

  constructor(options: OwnerQualityReviewStoreOptions = {}) {
    this.file = options.file ?? path.join(setupConfigDir(), 'quality-owner-decisions.json');
    this.now = options.now ?? (() => new Date());
    this.maxRecords = Math.max(100, Math.min(options.maxRecords ?? 2000, 10_000));
  }

  private readonly validRecord = (value: unknown): value is OwnerQualityDecisionRecord => {
    if (!value || typeof value !== 'object') return false;
    const item = value as Partial<OwnerQualityDecisionRecord>;
    return (
      item.version === 1 &&
      typeof item.id === 'string' &&
      typeof item.observationId === 'string' &&
      typeof item.observationDigest === 'string' &&
      /^[a-f0-9]{64}$/.test(item.observationDigest) &&
      ['approved', 'rejected', 'revoked'].includes(item.decision ?? '') &&
      (item.reason === undefined || typeof item.reason === 'string') &&
      typeof item.createdAt === 'string'
    );
  };

  private async load(): Promise<OwnerQualityDecisionFileV1> {
    try {
      const parsed = JSON.parse((await fs.readFile(this.file, 'utf8')).replace(/^\uFEFF/, '')) as Partial<OwnerQualityDecisionFileV1>;
      if (parsed.version !== 1 || !Array.isArray(parsed.decisions)) {
        throw new Error(`Invalid owner quality review store at '${this.file}'.`);
      }
      return { version: 1, decisions: parsed.decisions.filter(this.validRecord) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, decisions: [] };
      throw error;
    }
  }

  private async save(state: OwnerQualityDecisionFileV1): Promise<void> {
    if (state.decisions.length > this.maxRecords) {
      state.decisions = state.decisions.slice(-this.maxRecords);
    }
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temp, this.file);
    if (process.platform !== 'win32') await fs.chmod(this.file, 0o600);
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail;
    let release!: () => void;
    this.mutationTail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async list(limit = 100): Promise<OwnerQualityDecisionRecord[]> {
    const boundedLimit = Math.max(1, Math.min(limit, 500));
    const state = await this.load();
    return state.decisions.slice(-boundedLimit).reverse().map(item => structuredClone(item));
  }

  async latest(observationId: string): Promise<OwnerQualityDecisionRecord | undefined> {
    const state = await this.load();
    for (let index = state.decisions.length - 1; index >= 0; index -= 1) {
      const item = state.decisions[index];
      if (item?.observationId === observationId) return structuredClone(item);
    }
    return undefined;
  }

  async decide(
    observation: QualityObservationRecord,
    decision: OwnerQualityDecisionKind,
    reason?: string
  ): Promise<OwnerQualityDecisionRecord> {
    if (observation.candidateState !== 'pending-owner-review') {
      throw new Error('Only pending-owner-review observations can receive an owner decision.');
    }
    if (observation.promotionState !== 'not-promoted' || observation.active !== false) {
      throw new Error('Owner review cannot operate on promoted or active observations.');
    }

    return this.mutate(async () => {
      const state = await this.load();
      const latest = [...state.decisions].reverse().find(item => item.observationId === observation.id);
      const digest = qualityObservationDigest(observation);

      if (latest?.observationDigest !== undefined && latest.observationDigest !== digest) {
        throw new Error('Observation evidence changed after a prior owner decision.');
      }
      if (decision === 'revoked' && latest?.decision !== 'approved') {
        throw new Error('Only a previously approved observation can be revoked.');
      }
      if (latest?.decision === decision) return structuredClone(latest);

      const record: OwnerQualityDecisionRecord = {
        version: 1,
        id: randomUUID(),
        observationId: observation.id,
        observationDigest: digest,
        decision,
        createdAt: this.now().toISOString()
      };
      const bounded = boundedReason(reason);
      if (bounded) record.reason = bounded;

      state.decisions.push(record);
      await this.save(state);
      return structuredClone(record);
    });
  }
}
