import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ACTION_SCHEMA_VERSION, ENGINEERING_API_VERSION, SERVER_VERSION } from './capabilities.js';
import { resolveResourceOwner, type ResourceOwnerSource } from './security/execution-context.js';
import { setupConfigDir } from './setup/settings.js';
import { IMPLICIT_WORK_SESSION_ID } from './work-session.js';
import type { WorkflowRunRecord, WorkflowRunStatus } from './workflow-run-store.js';

export type QualityCompletionSource = 'workflow-output' | 'exception' | 'runtime-reconciliation';
export type QualityCandidateState = 'ineligible' | 'pending-owner-review';
export type QualityPromotionState = 'not-promoted';

export interface EnvironmentFingerprint {
  version: 1;
  hash: string;
  platform: NodeJS.Platform;
  arch: string;
  nodeMajor: number;
  serverVersion: string;
  actionSchemaVersion: number;
  engineeringApiVersion: number;
}

export interface QualityGateCheck {
  id: 'succeeded' | 'explicit-outcome' | 'explicit-work-session' | 'typed-completion';
  passed: boolean;
}

export interface QualityObservationRecord {
  version: 1;
  id: string;
  principalId: string;
  workSessionId: string;
  workflowRunId: string;
  workspace: string;
  projectPath: string;
  workflow: string;
  outcome: Exclude<WorkflowRunStatus, 'running'>;
  completionSource: QualityCompletionSource;
  explicitOutcome: boolean;
  durationMs: number;
  environment: EnvironmentFingerprint;
  qualityGate: {
    passed: boolean;
    checks: QualityGateCheck[];
  };
  antiPatterns: string[];
  candidateState: QualityCandidateState;
  promotionState: QualityPromotionState;
  active: false;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

interface QualityObservationFileV1 {
  version: 1;
  observations: QualityObservationRecord[];
}

export interface QualityObservationStoreOptions {
  file?: string;
  now?: () => Date;
  maxRecords?: number;
}

export interface QualityObservationInput {
  completionSource: QualityCompletionSource;
  explicitOutcome: boolean;
}

function bounded(value: string | undefined, max: number): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  return normalized.slice(0, max);
}

function elapsedMs(run: WorkflowRunRecord): number {
  const start = Date.parse(run.startedAt);
  const end = Date.parse(run.endedAt ?? run.updatedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, end - start);
}

function environmentFingerprintHash(
  value: Omit<EnvironmentFingerprint, 'version' | 'hash'>
): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function buildEnvironmentFingerprint(): EnvironmentFingerprint {
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10) || 0;
  const canonical = {
    platform: process.platform,
    arch: process.arch,
    nodeMajor,
    serverVersion: SERVER_VERSION,
    actionSchemaVersion: ACTION_SCHEMA_VERSION,
    engineeringApiVersion: ENGINEERING_API_VERSION
  };
  return {
    version: 1,
    hash: environmentFingerprintHash(canonical),
    ...canonical
  };
}

export function evaluateQualityGate(
  run: WorkflowRunRecord,
  input: QualityObservationInput
): {
  checks: QualityGateCheck[];
  antiPatterns: string[];
  passed: boolean;
} {
  const checks: QualityGateCheck[] = [
    { id: 'succeeded', passed: run.status === 'succeeded' },
    { id: 'explicit-outcome', passed: input.explicitOutcome },
    { id: 'explicit-work-session', passed: run.workSessionId !== IMPLICIT_WORK_SESSION_ID },
    { id: 'typed-completion', passed: input.completionSource === 'workflow-output' }
  ];
  const antiPatterns: string[] = [];
  if (run.status !== 'succeeded') antiPatterns.push('non-success-outcome');
  if (!input.explicitOutcome) antiPatterns.push('ambiguous-outcome-evidence');
  if (run.workSessionId === IMPLICIT_WORK_SESSION_ID) antiPatterns.push('implicit-work-session');
  if (input.completionSource === 'exception') antiPatterns.push('exception-completion');
  if (input.completionSource === 'runtime-reconciliation') antiPatterns.push('runtime-reconciliation');
  return {
    checks,
    antiPatterns,
    passed: checks.every(check => check.passed)
  };
}

export class QualityObservationStore {
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly file: string;
  private readonly now: () => Date;
  private readonly maxRecords: number;

  constructor(
    private readonly ownerSource: ResourceOwnerSource = 'unknown',
    options: QualityObservationStoreOptions = {}
  ) {
    this.file = options.file ?? path.join(setupConfigDir(), 'quality-observations.json');
    this.now = options.now ?? (() => new Date());
    this.maxRecords = Math.max(100, Math.min(options.maxRecords ?? 2000, 10_000));
  }

  private readonly validRecord = (value: unknown): value is QualityObservationRecord => {
    if (!value || typeof value !== 'object') return false;
    const item = value as Partial<QualityObservationRecord>;
    if (
      item.version !== 1 ||
      typeof item.id !== 'string' ||
      typeof item.principalId !== 'string' ||
      typeof item.workSessionId !== 'string' ||
      typeof item.workflowRunId !== 'string' ||
      typeof item.workspace !== 'string' ||
      typeof item.projectPath !== 'string' ||
      typeof item.workflow !== 'string' ||
      !['succeeded', 'failed', 'blocked'].includes(item.outcome ?? '') ||
      !['workflow-output', 'exception', 'runtime-reconciliation'].includes(item.completionSource ?? '') ||
      typeof item.explicitOutcome !== 'boolean' ||
      typeof item.durationMs !== 'number' ||
      !Number.isFinite(item.durationMs) ||
      item.durationMs < 0 ||
      item.promotionState !== 'not-promoted' ||
      item.active !== false ||
      typeof item.createdAt !== 'string' ||
      typeof item.updatedAt !== 'string'
    ) return false;

    const environment = item.environment as Partial<EnvironmentFingerprint> | undefined;
    if (
      environment?.version !== 1 ||
      typeof environment.hash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(environment.hash) ||
      typeof environment.platform !== 'string' ||
      typeof environment.arch !== 'string' ||
      typeof environment.nodeMajor !== 'number' ||
      !Number.isInteger(environment.nodeMajor) ||
      typeof environment.serverVersion !== 'string' ||
      typeof environment.actionSchemaVersion !== 'number' ||
      typeof environment.engineeringApiVersion !== 'number'
    ) return false;
    const expectedEnvironmentHash = environmentFingerprintHash({
      platform: environment.platform as NodeJS.Platform,
      arch: environment.arch,
      nodeMajor: environment.nodeMajor,
      serverVersion: environment.serverVersion,
      actionSchemaVersion: environment.actionSchemaVersion,
      engineeringApiVersion: environment.engineeringApiVersion
    });
    if (environment.hash !== expectedEnvironmentHash) return false;

    const expectedChecks: QualityGateCheck[] = [
      { id: 'succeeded', passed: item.outcome === 'succeeded' },
      { id: 'explicit-outcome', passed: item.explicitOutcome },
      { id: 'explicit-work-session', passed: item.workSessionId !== IMPLICIT_WORK_SESSION_ID },
      { id: 'typed-completion', passed: item.completionSource === 'workflow-output' }
    ];
    const expectedPassed = expectedChecks.every(check => check.passed);
    const gate = item.qualityGate as QualityObservationRecord['qualityGate'] | undefined;
    if (
      typeof gate?.passed !== 'boolean' ||
      gate.passed !== expectedPassed ||
      !Array.isArray(gate.checks) ||
      JSON.stringify(gate.checks) !== JSON.stringify(expectedChecks)
    ) return false;

    const expectedAntiPatterns: string[] = [];
    if (item.outcome !== 'succeeded') expectedAntiPatterns.push('non-success-outcome');
    if (!item.explicitOutcome) expectedAntiPatterns.push('ambiguous-outcome-evidence');
    if (item.workSessionId === IMPLICIT_WORK_SESSION_ID) expectedAntiPatterns.push('implicit-work-session');
    if (item.completionSource === 'exception') expectedAntiPatterns.push('exception-completion');
    if (item.completionSource === 'runtime-reconciliation') expectedAntiPatterns.push('runtime-reconciliation');
    if (
      !Array.isArray(item.antiPatterns) ||
      JSON.stringify(item.antiPatterns) !== JSON.stringify(expectedAntiPatterns)
    ) return false;

    return item.candidateState === (expectedPassed ? 'pending-owner-review' : 'ineligible');
  };

  private async load(): Promise<QualityObservationFileV1> {
    try {
      const parsed = JSON.parse((await fs.readFile(this.file, 'utf8')).replace(/^\uFEFF/, '')) as Partial<QualityObservationFileV1>;
      if (parsed.version !== 1 || !Array.isArray(parsed.observations)) {
        throw new Error(`Invalid quality observation store at '${this.file}'.`);
      }
      return { version: 1, observations: parsed.observations.filter(this.validRecord) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, observations: [] };
      throw error;
    }
  }

  private async save(state: QualityObservationFileV1): Promise<void> {
    if (state.observations.length > this.maxRecords) {
      state.observations = state.observations.slice(-this.maxRecords);
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

  async observe(
    run: WorkflowRunRecord,
    input: QualityObservationInput
  ): Promise<QualityObservationRecord> {
    if (run.status === 'running') throw new Error('Cannot observe a running workflow.');
    const timestamp = this.now().toISOString();
    const gate = evaluateQualityGate(run, input);
    const record: QualityObservationRecord = {
      version: 1,
      id: randomUUID(),
      principalId: run.principalId,
      workSessionId: run.workSessionId,
      workflowRunId: run.id,
      workspace: run.workspace,
      projectPath: run.projectPath,
      workflow: run.workflow,
      outcome: run.status,
      completionSource: input.completionSource,
      explicitOutcome: input.explicitOutcome,
      durationMs: elapsedMs(run),
      environment: buildEnvironmentFingerprint(),
      qualityGate: {
        passed: gate.passed,
        checks: gate.checks
      },
      antiPatterns: gate.antiPatterns,
      candidateState: gate.passed ? 'pending-owner-review' : 'ineligible',
      promotionState: 'not-promoted',
      active: false,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    const error = bounded(run.error, 1024);
    if (error) record.error = error;

    return this.mutate(async () => {
      const state = await this.load();
      const existing = state.observations.find(item => item.workflowRunId === run.id);
      if (existing) return structuredClone(existing);
      state.observations.push(record);
      await this.save(state);
      return structuredClone(record);
    });
  }

  async list(limit = 50): Promise<QualityObservationRecord[]> {
    const owner = resolveResourceOwner(this.ownerSource);
    const boundedLimit = Math.max(1, Math.min(limit, 200));
    const state = await this.load();
    return state.observations
      .filter(item =>
        item.principalId === owner.principalId &&
        item.workSessionId === owner.workSessionId
      )
      .slice(-boundedLimit)
      .reverse()
      .map(item => structuredClone(item));
  }
}
