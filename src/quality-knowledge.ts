import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { QualityObservationRecord } from './quality-learning.js';
import { QualityObservationStore } from './quality-learning.js';
import { QualityLearningSettingsStore } from './quality-learning-policy.js';
import {
  OwnerQualityReviewStore,
  qualityObservationDigest
} from './quality-review.js';
import { setupConfigDir } from './setup/settings.js';

export type KnowledgeExecutionKind = 'typed-workflow' | 'manual' | 'raw-shell';
export type CanonicalBaselineStatus = 'matches-canonical' | 'prefer-canonical' | 'no-canonical';
export type ReusableKnowledgeState = 'draft' | 'shadow' | 'promoted' | 'revoked';
export type ReusableKnowledgeClass = 'experimental' | 'proven-learned';
export type ShadowEvaluationStatus =
  | 'not-run'
  | 'passed'
  | 'failed'
  | 'needs-more-evidence'
  | 'needs-revalidation';

export interface CanonicalBaselineComparison {
  status: CanonicalBaselineStatus;
  canonicalWorkflow?: string;
  antiPatterns: string[];
  reason: string;
}

export interface QualityMetrics {
  totalSamples: number;
  approvedSamples: number;
  succeeded: number;
  failed: number;
  blocked: number;
  successRate: number;
  meanDurationMs: number;
  durationCv: number;
  consistencyScore: number;
  typedCompletionRatio: number;
  environmentDiversity: number;
  recencyDays: number;
  timeSpanDays: number;
  reproducibilityScore: number;
  safetyPenalty: number;
  score: number;
}

export interface PromotionGate {
  passed: boolean;
  reasons: string[];
}

export interface ShadowEvaluation {
  status: ShadowEvaluationStatus;
  evaluatedAt?: string;
  environmentHash?: string;
  reasons: string[];
}

export interface ReusableKnowledgeRecord {
  version: 1;
  recordDigest: string;
  id: string;
  knowledgeKey: string;
  knowledgeVersion: number;
  revision: number;
  supersedesId?: string;
  workspace: string;
  projectPath: string;
  workflow: string;
  class: ReusableKnowledgeClass;
  state: ReusableKnowledgeState;
  recommendationOnly: true;
  executionActive: false;
  sourceObservationIds: string[];
  sourceObservationDigests: string[];
  environmentHashes: string[];
  metrics: QualityMetrics;
  baseline: CanonicalBaselineComparison;
  promotionGate: PromotionGate;
  shadow: ShadowEvaluation;
  createdAt: string;
  reason?: string;
}

interface ReusableKnowledgeFileV1 {
  version: 1;
  records: ReusableKnowledgeRecord[];
}

export interface QualityKnowledgeStoreOptions {
  file?: string;
  observationFile?: string;
  reviewFile?: string;
  settingsFile?: string;
  now?: () => Date;
  maxRecords?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function coefficientOfVariation(values: number[]): number {
  if (values.length <= 1) return 0;
  const avg = mean(values);
  if (avg <= 0) return 0;
  const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length;
  return Math.sqrt(variance) / avg;
}

function knowledgeKey(workspace: string, projectPath: string, workflow: string): string {
  return createHash('sha256')
    .update(JSON.stringify({ workspace, projectPath, workflow }))
    .digest('hex');
}

function latestByObservation(
  decisions: Awaited<ReturnType<OwnerQualityReviewStore['list']>>
): Map<string, (typeof decisions)[number]> {
  const result = new Map<string, (typeof decisions)[number]>();
  for (const decision of decisions) {
    if (!result.has(decision.observationId)) result.set(decision.observationId, decision);
  }
  return result;
}

function boundedReason(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  return normalized.slice(0, 512);
}

function reusableKnowledgeDigest(
  value: Omit<ReusableKnowledgeRecord, 'recordDigest'> | ReusableKnowledgeRecord
): string {
  const { recordDigest: _ignored, ...canonical } = value as ReusableKnowledgeRecord;
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function sealReusableKnowledge(
  value: Omit<ReusableKnowledgeRecord, 'recordDigest'> | ReusableKnowledgeRecord
): ReusableKnowledgeRecord {
  const { recordDigest: _ignored, ...canonical } = value as ReusableKnowledgeRecord;
  return {
    ...canonical,
    recordDigest: reusableKnowledgeDigest(canonical)
  };
}

export function compareCanonicalBaseline(input: {
  workflow: string;
  executionKind: KnowledgeExecutionKind;
  canonicalWorkflowAvailable: boolean;
}): CanonicalBaselineComparison {
  if (input.canonicalWorkflowAvailable && input.executionKind !== 'typed-workflow') {
    const antiPattern = input.executionKind === 'raw-shell'
      ? 'raw-shell-when-typed-workflow-exists'
      : 'manual-sequence-when-typed-workflow-exists';
    return {
      status: 'prefer-canonical',
      canonicalWorkflow: input.workflow,
      antiPatterns: [antiPattern],
      reason: 'A canonical typed workflow already exists and must be preferred over learned manual execution.'
    };
  }
  if (input.canonicalWorkflowAvailable) {
    return {
      status: 'matches-canonical',
      canonicalWorkflow: input.workflow,
      antiPatterns: [],
      reason: 'Evidence came from the canonical typed workflow; learned knowledge may only improve recommendation confidence.'
    };
  }
  return {
    status: 'no-canonical',
    antiPatterns: [],
    reason: 'No canonical typed workflow baseline was supplied; learned knowledge remains non-executable until separately engineered.'
  };
}

export function calculateQualityMetrics(
  observations: QualityObservationRecord[],
  approvedObservationIds: Set<string>,
  now = new Date()
): QualityMetrics {
  const totalSamples = observations.length;
  const succeeded = observations.filter(item => item.outcome === 'succeeded').length;
  const failed = observations.filter(item => item.outcome === 'failed').length;
  const blocked = observations.filter(item => item.outcome === 'blocked').length;
  const approvedSamples = observations.filter(item => approvedObservationIds.has(item.id)).length;
  const successRate = totalSamples === 0 ? 0 : succeeded / totalSamples;
  const durations = observations
    .filter(item => item.outcome === 'succeeded')
    .map(item => item.durationMs)
    .filter(value => Number.isFinite(value) && value >= 0);
  const meanDurationMs = mean(durations);
  // Sub-100 ms workflows are dominated by scheduler/clock granularity. Treat that
  // region as insufficient timing resolution instead of penalizing otherwise
  // deterministic evidence for 1 ms of measurement noise.
  const durationCv = meanDurationMs < 100 ? 0 : coefficientOfVariation(durations);
  const consistencyScore = clamp01(1 / (1 + durationCv));
  const typedCount = observations.filter(item => item.completionSource === 'workflow-output').length;
  const typedCompletionRatio = totalSamples === 0 ? 0 : typedCount / totalSamples;
  const environmentDiversity = new Set(observations.map(item => item.environment.hash)).size;

  const timestamps = observations
    .map(item => Date.parse(item.createdAt))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const newest = timestamps.at(-1) ?? now.getTime();
  const oldest = timestamps[0] ?? newest;
  const recencyDays = Math.max(0, (now.getTime() - newest) / DAY_MS);
  const timeSpanDays = Math.max(0, (newest - oldest) / DAY_MS);
  const recencyScore = recencyDays <= 30 ? 1 : recencyDays <= 90 ? 0.75 : recencyDays <= 365 ? 0.5 : 0.25;
  const diversityScore = clamp01(environmentDiversity / 3);
  const reproducibilityScore = clamp01(successRate * consistencyScore);

  const severeAntiPatternSamples = observations.filter(item =>
    item.antiPatterns.some(pattern => [
      'ambiguous-outcome-evidence',
      'implicit-work-session',
      'exception-completion',
      'runtime-reconciliation'
    ].includes(pattern))
  ).length;
  const safetyPenalty = totalSamples === 0 ? 0 : Math.min(0.4, severeAntiPatternSamples / totalSamples * 0.4);

  const score = clamp01(
    successRate * 0.35 +
    consistencyScore * 0.20 +
    reproducibilityScore * 0.20 +
    typedCompletionRatio * 0.15 +
    diversityScore * 0.05 +
    recencyScore * 0.05 -
    safetyPenalty
  );

  return {
    totalSamples,
    approvedSamples,
    succeeded,
    failed,
    blocked,
    successRate: round(successRate),
    meanDurationMs: Math.round(meanDurationMs),
    durationCv: round(durationCv),
    consistencyScore: round(consistencyScore),
    typedCompletionRatio: round(typedCompletionRatio),
    environmentDiversity,
    recencyDays: round(recencyDays, 2),
    timeSpanDays: round(timeSpanDays, 2),
    reproducibilityScore: round(reproducibilityScore),
    safetyPenalty: round(safetyPenalty),
    score: round(score)
  };
}

export class QualityKnowledgeStore {
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly file: string;
  private readonly observations: QualityObservationStore;
  private readonly reviews: OwnerQualityReviewStore;
  private readonly settings: QualityLearningSettingsStore;
  private readonly now: () => Date;
  private readonly maxRecords: number;

  constructor(options: QualityKnowledgeStoreOptions = {}) {
    this.file = options.file ?? path.join(setupConfigDir(), 'quality-reusable-knowledge.json');
    this.observations = new QualityObservationStore('local-owner', {
      file: options.observationFile,
      settingsFile: options.settingsFile
    });
    this.reviews = new OwnerQualityReviewStore({ file: options.reviewFile });
    this.settings = new QualityLearningSettingsStore({ file: options.settingsFile });
    this.now = options.now ?? (() => new Date());
    this.maxRecords = Math.max(100, Math.min(options.maxRecords ?? 2000, 10_000));
  }

  private readonly validRecord = (value: unknown): value is ReusableKnowledgeRecord => {
    if (!value || typeof value !== 'object') return false;
    const item = value as Partial<ReusableKnowledgeRecord>;
    const structurallyValid = item.version === 1 &&
      typeof item.recordDigest === 'string' &&
      /^[a-f0-9]{64}$/.test(item.recordDigest) &&
      typeof item.id === 'string' &&
      typeof item.knowledgeKey === 'string' &&
      /^[a-f0-9]{64}$/.test(item.knowledgeKey) &&
      typeof item.knowledgeVersion === 'number' &&
      Number.isInteger(item.knowledgeVersion) &&
      item.knowledgeVersion >= 1 &&
      typeof item.revision === 'number' &&
      Number.isInteger(item.revision) &&
      item.revision >= 1 &&
      typeof item.workspace === 'string' &&
      typeof item.projectPath === 'string' &&
      typeof item.workflow === 'string' &&
      ['experimental', 'proven-learned'].includes(item.class ?? '') &&
      ['draft', 'shadow', 'promoted', 'revoked'].includes(item.state ?? '') &&
      item.recommendationOnly === true &&
      item.executionActive === false &&
      Array.isArray(item.sourceObservationIds) &&
      item.sourceObservationIds.every(id => typeof id === 'string') &&
      Array.isArray(item.sourceObservationDigests) &&
      item.sourceObservationDigests.every(digest => typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest)) &&
      Array.isArray(item.environmentHashes) &&
      item.environmentHashes.every(hash => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash)) &&
      typeof item.metrics === 'object' && item.metrics !== null &&
      typeof item.baseline === 'object' && item.baseline !== null &&
      typeof item.promotionGate === 'object' && item.promotionGate !== null &&
      typeof item.shadow === 'object' && item.shadow !== null &&
      typeof item.createdAt === 'string';
    if (!structurallyValid) return false;
    return item.recordDigest === reusableKnowledgeDigest(item as ReusableKnowledgeRecord);
  };

  private async load(): Promise<ReusableKnowledgeFileV1> {
    try {
      const parsed = JSON.parse((await fs.readFile(this.file, 'utf8')).replace(/^\uFEFF/, '')) as Partial<ReusableKnowledgeFileV1>;
      if (parsed.version !== 1 || !Array.isArray(parsed.records)) {
        throw new Error(`Invalid reusable quality knowledge store at '${this.file}'.`);
      }
      return { version: 1, records: parsed.records.filter(this.validRecord) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, records: [] };
      throw error;
    }
  }

  private async save(state: ReusableKnowledgeFileV1): Promise<void> {
    if (state.records.length > this.maxRecords) state.records = state.records.slice(-this.maxRecords);
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

  private async latestForKey(key: string): Promise<ReusableKnowledgeRecord | undefined> {
    const state = await this.load();
    for (let index = state.records.length - 1; index >= 0; index -= 1) {
      const item = state.records[index];
      if (item?.knowledgeKey === key) return structuredClone(item);
    }
    return undefined;
  }

  private promotionGate(
    metrics: QualityMetrics,
    baseline: CanonicalBaselineComparison,
    minApprovedSamples: number,
    minScore: number,
    approvedObservations: QualityObservationRecord[]
  ): PromotionGate {
    const reasons: string[] = [];
    if (metrics.approvedSamples < minApprovedSamples) reasons.push('insufficient-approved-samples');
    if (metrics.successRate < 0.8) reasons.push('success-rate-below-0.8');
    if (metrics.typedCompletionRatio !== 1) reasons.push('non-typed-evidence-present');
    if (metrics.score < minScore) reasons.push('quality-score-below-threshold');
    if (baseline.status === 'prefer-canonical') reasons.push('canonical-workflow-is-safer-than-candidate');
    if (baseline.antiPatterns.length > 0) reasons.push('canonical-baseline-anti-pattern');
    if (approvedObservations.some(item =>
      item.antiPatterns.some(pattern => [
        'ambiguous-outcome-evidence',
        'implicit-work-session',
        'exception-completion',
        'runtime-reconciliation'
      ].includes(pattern))
    )) reasons.push('unsafe-evidence-present');
    return { passed: reasons.length === 0, reasons };
  }

  async list(limit = 100): Promise<ReusableKnowledgeRecord[]> {
    const state = await this.load();
    const boundedLimit = Math.max(1, Math.min(limit, 500));
    return state.records.slice(-boundedLimit).reverse().map(item => structuredClone(item));
  }

  async latest(id: string): Promise<ReusableKnowledgeRecord | undefined> {
    const state = await this.load();
    const seed = state.records.find(item => item.id === id);
    if (!seed) return undefined;
    for (let index = state.records.length - 1; index >= 0; index -= 1) {
      const item = state.records[index];
      if (item?.knowledgeKey === seed.knowledgeKey) return structuredClone(item);
    }
    return undefined;
  }

  async createDraft(workspace: string, projectPath: string, workflow: string): Promise<ReusableKnowledgeRecord> {
    const settings = await this.settings.load();
    if (!settings.enabled) throw new Error('Selective quality learning is disabled by the local owner.');

    const all = (await this.observations.listForOwnerLearning(10_000))
      .filter(item =>
        item.workspace === workspace &&
        item.projectPath === projectPath &&
        item.workflow === workflow
      );
    if (all.length === 0) throw new Error('No quality observations exist for this project workflow.');

    const decisions = await this.reviews.list(10_000);
    const latestDecisions = latestByObservation(decisions);
    const approved = all.filter(item => {
      const decision = latestDecisions.get(item.id);
      if (decision?.decision !== 'approved') return false;
      if (decision.observationDigest !== qualityObservationDigest(item)) {
        throw new Error('Owner approval digest does not match current observation evidence.');
      }
      return item.qualityGate.passed &&
        item.candidateState === 'pending-owner-review' &&
        item.promotionState === 'not-promoted' &&
        item.active === false &&
        item.completionSource === 'workflow-output' &&
        item.antiPatterns.length === 0;
    });
    const approvedIds = new Set(approved.map(item => item.id));
    const metrics = calculateQualityMetrics(all, approvedIds, this.now());
    const baseline = compareCanonicalBaseline({
      workflow,
      executionKind: 'typed-workflow',
      canonicalWorkflowAvailable: true
    });
    const gate = this.promotionGate(
      metrics,
      baseline,
      settings.minApprovedSamples,
      settings.minScore,
      approved
    );
    const key = knowledgeKey(workspace, projectPath, workflow);
    const state = await this.load();
    const priorPromotedVersions = state.records
      .filter(item => item.knowledgeKey === key && item.state === 'promoted')
      .map(item => item.knowledgeVersion);
    const nextVersion = (priorPromotedVersions.length > 0 ? Math.max(...priorPromotedVersions) : 0) + 1;
    const prior = await this.latestForKey(key);

    const record = sealReusableKnowledge({
      version: 1,
      id: randomUUID(),
      knowledgeKey: key,
      knowledgeVersion: nextVersion,
      revision: (prior?.revision ?? 0) + 1,
      ...(prior ? { supersedesId: prior.id } : {}),
      workspace,
      projectPath,
      workflow,
      class: 'experimental',
      state: 'draft',
      recommendationOnly: true,
      executionActive: false,
      sourceObservationIds: approved.map(item => item.id),
      sourceObservationDigests: approved.map(item => qualityObservationDigest(item)),
      environmentHashes: [...new Set(approved.map(item => item.environment.hash))].sort(),
      metrics,
      baseline,
      promotionGate: gate,
      shadow: { status: 'not-run', reasons: [] },
      createdAt: this.now().toISOString()
    });

    return this.mutate(async () => {
      const current = await this.load();
      current.records.push(record);
      await this.save(current);
      return structuredClone(record);
    });
  }

  private async latestApprovedEnvironmentHash(
    record: ReusableKnowledgeRecord
  ): Promise<string> {
    const observations = (await this.observations.listForOwnerLearning(10_000))
      .filter(item =>
        item.workspace === record.workspace &&
        item.projectPath === record.projectPath &&
        item.workflow === record.workflow &&
        item.qualityGate.passed &&
        item.candidateState === 'pending-owner-review' &&
        item.promotionState === 'not-promoted' &&
        item.active === false &&
        item.completionSource === 'workflow-output'
      );
    const decisions = latestByObservation(await this.reviews.list(10_000));
    for (let index = observations.length - 1; index >= 0; index -= 1) {
      const observation = observations[index]!;
      const decision = decisions.get(observation.id);
      if (
        decision?.decision === 'approved' &&
        decision.observationDigest === qualityObservationDigest(observation)
      ) {
        return observation.environment.hash;
      }
    }
    throw new Error('No owner-approved compatible environment evidence is available for this knowledge candidate.');
  }

  async evaluateShadowAgainstApprovedEvidence(id: string): Promise<ReusableKnowledgeRecord> {
    const source = await this.latest(id);
    if (!source) throw new Error(`Unknown reusable knowledge record '${id}'.`);
    return this.evaluateShadow(source.id, await this.latestApprovedEnvironmentHash(source));
  }

  async revalidateAgainstApprovedEvidence(id: string): Promise<ReusableKnowledgeRecord> {
    const source = await this.latest(id);
    if (!source) throw new Error(`Unknown reusable knowledge record '${id}'.`);
    return this.revalidateEnvironment(source.id, await this.latestApprovedEnvironmentHash(source));
  }

  async evaluateShadow(id: string, currentEnvironmentHash: string): Promise<ReusableKnowledgeRecord> {
    if (!/^[a-f0-9]{64}$/.test(currentEnvironmentHash)) {
      throw new Error('currentEnvironmentHash must be a SHA-256 fingerprint.');
    }
    const source = await this.latest(id);
    if (!source) throw new Error(`Unknown reusable knowledge record '${id}'.`);
    if (source.state === 'promoted' || source.state === 'revoked') {
      throw new Error('Promoted or revoked knowledge cannot be shadow-evaluated in place; create a new candidate version.');
    }

    let status: ShadowEvaluationStatus = 'passed';
    const reasons = [...source.promotionGate.reasons];
    if (source.metrics.approvedSamples === 0 || reasons.includes('insufficient-approved-samples')) {
      status = 'needs-more-evidence';
    } else if (!source.environmentHashes.includes(currentEnvironmentHash)) {
      status = 'needs-revalidation';
      reasons.push('current-environment-not-in-evidence');
    } else if (!source.promotionGate.passed) {
      status = 'failed';
    }

    const next = sealReusableKnowledge({
      ...structuredClone(source),
      id: randomUUID(),
      revision: source.revision + 1,
      supersedesId: source.id,
      state: 'shadow',
      class: 'experimental',
      executionActive: false,
      shadow: {
        status,
        evaluatedAt: this.now().toISOString(),
        environmentHash: currentEnvironmentHash,
        reasons: [...new Set(reasons)]
      },
      createdAt: this.now().toISOString()
    });

    return this.mutate(async () => {
      const state = await this.load();
      state.records.push(next);
      await this.save(state);
      return structuredClone(next);
    });
  }

  async promote(id: string, reason?: string): Promise<ReusableKnowledgeRecord> {
    const settings = await this.settings.load();
    if (!settings.enabled) throw new Error('Selective quality learning is disabled by the local owner.');
    const source = await this.latest(id);
    if (!source) throw new Error(`Unknown reusable knowledge record '${id}'.`);
    if (source.state !== 'shadow' || source.shadow.status !== 'passed' || !source.promotionGate.passed) {
      throw new Error('Only a shadow-passed candidate with a passing promotion gate can be promoted.');
    }

    const next = sealReusableKnowledge({
      ...structuredClone(source),
      id: randomUUID(),
      revision: source.revision + 1,
      supersedesId: source.id,
      state: 'promoted',
      class: 'proven-learned',
      recommendationOnly: true,
      executionActive: false,
      createdAt: this.now().toISOString(),
      ...(boundedReason(reason) ? { reason: boundedReason(reason) } : {})
    });

    return this.mutate(async () => {
      const state = await this.load();
      state.records.push(next);
      await this.save(state);
      return structuredClone(next);
    });
  }

  async revalidateEnvironment(id: string, currentEnvironmentHash: string): Promise<ReusableKnowledgeRecord> {
    if (!/^[a-f0-9]{64}$/.test(currentEnvironmentHash)) {
      throw new Error('currentEnvironmentHash must be a SHA-256 fingerprint.');
    }
    const source = await this.latest(id);
    if (!source) throw new Error(`Unknown reusable knowledge record '${id}'.`);
    if (source.state !== 'promoted') throw new Error('Only promoted knowledge requires environment revalidation.');
    if (source.environmentHashes.includes(currentEnvironmentHash)) return structuredClone(source);

    const next = sealReusableKnowledge({
      ...structuredClone(source),
      id: randomUUID(),
      revision: source.revision + 1,
      supersedesId: source.id,
      state: 'shadow',
      executionActive: false,
      shadow: {
        status: 'needs-revalidation',
        evaluatedAt: this.now().toISOString(),
        environmentHash: currentEnvironmentHash,
        reasons: ['material-environment-change']
      },
      createdAt: this.now().toISOString()
    });

    return this.mutate(async () => {
      const state = await this.load();
      state.records.push(next);
      await this.save(state);
      return structuredClone(next);
    });
  }

  async revoke(id: string, reason?: string): Promise<ReusableKnowledgeRecord> {
    const source = await this.latest(id);
    if (!source) throw new Error(`Unknown reusable knowledge record '${id}'.`);
    if (source.state !== 'promoted') throw new Error('Only promoted reusable knowledge can be revoked.');

    const next = sealReusableKnowledge({
      ...structuredClone(source),
      id: randomUUID(),
      revision: source.revision + 1,
      supersedesId: source.id,
      state: 'revoked',
      class: 'proven-learned',
      executionActive: false,
      createdAt: this.now().toISOString(),
      ...(boundedReason(reason) ? { reason: boundedReason(reason) } : {})
    });

    return this.mutate(async () => {
      const state = await this.load();
      state.records.push(next);
      await this.save(state);
      return structuredClone(next);
    });
  }

  async clearForOwner(): Promise<number> {
    return this.mutate(async () => {
      const state = await this.load();
      const count = state.records.length;
      await fs.rm(this.file, { force: true });
      return count;
    });
  }
}
