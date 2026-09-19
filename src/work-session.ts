import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setupConfigDir } from './setup/settings.js';

export const IMPLICIT_WORK_SESSION_ID = 'implicit' as const;

export type WorkSessionStatus =
  | 'created'
  | 'active'
  | 'idle'
  | 'blocked'
  | 'closing'
  | 'closed'
  | 'expired'
  | 'recovering';

export type ConcurrencyClass =
  | 'shared'
  | 'session-isolated'
  | 'resource-exclusive'
  | 'project-variant-exclusive'
  | 'node-exclusive'
  | 'owner-local-only';

export interface ResourceOwner {
  principalId: string;
  workSessionId: string;
  implicit: boolean;
  key: string;
}

export interface ContextCapsuleProject {
  workspace: string;
  projectPath?: string;
  repoPath?: string;
  worktreePath?: string;
  branch?: string;
  commit?: string;
  buildDir?: string;
}

export interface WorkSessionLifecyclePolicy {
  idleAfterMinutes?: number;
  expireAfterMinutes?: number;
}

export interface ContextCapsule {
  version: 1;
  project?: ContextCapsuleProject;
  currentObjective?: string;
  role?: string;
  validatedFacts: string[];
  selectedProvider?: string;
  selectedToolchain?: string;
  selectedVariant?: string;
  completedTasks: string[];
  currentTask?: string;
  lastSuccessfulBuild?: string;
  lastSuccessfulDeploy?: string;
  lastAcceptance?: string;
  blockers: string[];
  decisions: string[];
  resourceState: string[];
  pendingActions: string[];
  nextRecommendedEngineeringAction?: string;
}

export interface WorkSession {
  version: 1;
  id: string;
  principalId: string;
  status: WorkSessionStatus;
  name?: string;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  closedAt?: string;
  expiredAt?: string;
  lifecycleReason?: string;
  lifecyclePolicy?: WorkSessionLifecyclePolicy;
  capsule: ContextCapsule;
}

type PrincipalIdSource = string | (() => string);

interface WorkSessionFileV1 {
  version: 1;
  sessions: WorkSession[];
}

export interface WorkSessionCreateInput {
  name?: string;
  workspace?: string;
  projectPath?: string;
  objective?: string;
  role?: string;
  idleAfterMinutes?: number;
  expireAfterMinutes?: number;
}

export interface WorkSessionCheckpointInput {
  currentObjective?: string;
  role?: string;
  validatedFacts?: string[];
  selectedProvider?: string;
  selectedToolchain?: string;
  selectedVariant?: string;
  completedTasks?: string[];
  currentTask?: string;
  lastSuccessfulBuild?: string;
  lastSuccessfulDeploy?: string;
  lastAcceptance?: string;
  blockers?: string[];
  decisions?: string[];
  resourceState?: string[];
  pendingActions?: string[];
  nextRecommendedEngineeringAction?: string;
}

export interface WorkSessionStoreOptions {
  file?: string;
  now?: () => Date;
  terminalRetentionMs?: number;
  gcMaxRecords?: number;
}

export interface WorkSessionReconciliationResult {
  recovered: number;
  idled: number;
  expired: number;
}

export interface WorkSessionGarbageCollectionResult {
  removed: number;
  retainedWithWorktree: number;
}

const TERMINAL_STATUSES = new Set<WorkSessionStatus>(['closed', 'expired']);
const DEFAULT_TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_GC_MAX_RECORDS = 32;

function boundedText(value: string | undefined, field: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (normalized.length > max || normalized.includes('\0')) {
    throw new Error(field + ' must be non-empty text of at most ' + max + ' characters.');
  }
  assertNoSecretLikeContent(normalized, field);
  return normalized;
}

function assertNoSecretLikeContent(value: string, field: string): void {
  const secretPatterns: RegExp[] = [
    /authorization\s*:\s*bearer\s+\S+/i,
    /\bbearer\s+[A-Za-z0-9._~+\/-]{12,}/i,
    /\b(api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|passwd|secret)\s*[:=]\s*\S+/i,
    /\b(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,})\b/i,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i
  ];
  if (secretPatterns.some(pattern => pattern.test(value))) {
    throw new Error(field + ' appears to contain secret credential material; Context Capsules must remain non-secret.');
  }
}

function boundedList(
  values: string[] | undefined,
  field: string,
  maxItems = 32,
  maxLength = 512
): string[] | undefined {
  if (values === undefined) return undefined;
  if (values.length > maxItems) throw new Error(field + ' accepts at most ' + maxItems + ' items.');
  return values.map((value, index) => {
    const normalized = boundedText(value, field + '[' + index + ']', maxLength);
    if (!normalized) throw new Error(field + '[' + index + '] must not be empty.');
    return normalized;
  });
}

function normalizeLifecyclePolicy(
  idleAfterMinutes: number | undefined,
  expireAfterMinutes: number | undefined
): WorkSessionLifecyclePolicy | undefined {
  const boundedMinutes = (value: number | undefined, field: string): number | undefined => {
    if (value === undefined) return undefined;
    if (!Number.isInteger(value) || value < 1 || value > 43_200) {
      throw new Error(field + ' must be an integer between 1 and 43200 minutes.');
    }
    return value;
  };
  const idle = boundedMinutes(idleAfterMinutes, 'idleAfterMinutes');
  const expire = boundedMinutes(expireAfterMinutes, 'expireAfterMinutes');
  if (idle !== undefined && expire !== undefined && expire <= idle) {
    throw new Error('expireAfterMinutes must be greater than idleAfterMinutes.');
  }
  if (idle === undefined && expire === undefined) return undefined;
  return {
    ...(idle !== undefined ? { idleAfterMinutes: idle } : {}),
    ...(expire !== undefined ? { expireAfterMinutes: expire } : {})
  };
}

function validIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function validateSession(value: unknown): WorkSession {
  if (!value || typeof value !== 'object') throw new Error('Invalid Work Session record.');
  const item = value as Partial<WorkSession> & {
    capsule?: Partial<ContextCapsule>;
  };
  const validStatuses: WorkSessionStatus[] = [
    'created', 'active', 'idle', 'blocked', 'closing', 'closed', 'expired', 'recovering'
  ];
  if (
    item.version !== 1 ||
    typeof item.id !== 'string' ||
    !/^[0-9a-fA-F-]{36}$/.test(item.id) ||
    typeof item.principalId !== 'string' ||
    !validStatuses.includes(item.status as WorkSessionStatus) ||
    !validIsoTimestamp(item.createdAt) ||
    !validIsoTimestamp(item.updatedAt) ||
    !item.capsule ||
    item.capsule.version !== 1
  ) {
    throw new Error('Invalid Work Session record.');
  }

  const capsule = item.capsule;
  const normalized: WorkSession = {
    ...(item as WorkSession),
    lastActivityAt: validIsoTimestamp(item.lastActivityAt) ? item.lastActivityAt : item.updatedAt,
    capsule: {
      ...(capsule as ContextCapsule),
      validatedFacts: Array.isArray(capsule.validatedFacts) ? capsule.validatedFacts : [],
      completedTasks: Array.isArray(capsule.completedTasks) ? capsule.completedTasks : [],
      blockers: Array.isArray(capsule.blockers) ? capsule.blockers : [],
      decisions: Array.isArray(capsule.decisions) ? capsule.decisions : [],
      resourceState: Array.isArray(capsule.resourceState) ? capsule.resourceState : [],
      pendingActions: Array.isArray(capsule.pendingActions) ? capsule.pendingActions : []
    }
  };
  return normalized;
}

function isTerminal(status: WorkSessionStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export class WorkSessionStore {
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly file: string;
  private readonly now: () => Date;
  private readonly terminalRetentionMs: number;
  private readonly gcMaxRecords: number;

  constructor(
    private readonly principalIdSource: PrincipalIdSource = 'unknown',
    options: WorkSessionStoreOptions = {}
  ) {
    this.file = options.file ?? path.join(setupConfigDir(), 'work-sessions.json');
    this.now = options.now ?? (() => new Date());
    this.terminalRetentionMs = options.terminalRetentionMs ?? DEFAULT_TERMINAL_RETENTION_MS;
    this.gcMaxRecords = Math.max(1, Math.min(options.gcMaxRecords ?? DEFAULT_GC_MAX_RECORDS, 256));
  }

  private principalId(): string {
    const raw = typeof this.principalIdSource === 'function'
      ? this.principalIdSource()
      : this.principalIdSource;
    return raw.trim() || 'unknown';
  }

  private async load(): Promise<WorkSessionFileV1> {
    try {
      const parsed = JSON.parse((await fs.readFile(this.file, 'utf8')).replace(/^\uFEFF/, '')) as Partial<WorkSessionFileV1>;
      if (parsed.version !== 1 || !Array.isArray(parsed.sessions)) {
        throw new Error('Invalid Work Session store at ' + this.file + '.');
      }
      return { version: 1, sessions: parsed.sessions.map(validateSession) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, sessions: [] };
      throw error;
    }
  }

  private async save(state: WorkSessionFileV1): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temp = this.file + '.' + process.pid + '.' + Date.now() + '.tmp';
    await fs.writeFile(temp, JSON.stringify(state, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
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

  private applyTimeouts(session: WorkSession, now: Date): 'idle' | 'expired' | undefined {
    if (isTerminal(session.status) || session.status === 'closing') return undefined;
    const lastActivityMs = Date.parse(session.lastActivityAt);
    const ageMs = Math.max(0, now.getTime() - lastActivityMs);
    const expireMs = session.lifecyclePolicy?.expireAfterMinutes !== undefined
      ? session.lifecyclePolicy.expireAfterMinutes * 60_000
      : undefined;
    if (expireMs !== undefined && ageMs >= expireMs) {
      session.status = 'expired';
      session.expiredAt = now.toISOString();
      session.updatedAt = now.toISOString();
      session.lifecycleReason = 'IDLE_EXPIRY';
      return 'expired';
    }
    const idleMs = session.lifecyclePolicy?.idleAfterMinutes !== undefined
      ? session.lifecyclePolicy.idleAfterMinutes * 60_000
      : undefined;
    if (
      idleMs !== undefined &&
      ageMs >= idleMs &&
      (session.status === 'created' || session.status === 'active' || session.status === 'recovering')
    ) {
      session.status = 'idle';
      session.updatedAt = now.toISOString();
      session.lifecycleReason = 'IDLE_THRESHOLD';
      return 'idle';
    }
    return undefined;
  }

  private findOwned(state: WorkSessionFileV1, sessionId: string): WorkSession | undefined {
    const principalId = this.principalId();
    return state.sessions.find(item => item.id === sessionId && item.principalId === principalId);
  }

  private snapshotWithTimeouts(session: WorkSession, now = this.now()): WorkSession {
    const snapshot = structuredClone(session);
    this.applyTimeouts(snapshot, now);
    return snapshot;
  }

  private assertUsable(session: WorkSession): void {
    if (session.status === 'closing') {
      throw new Error('Work Session ' + session.id + ' is closing.');
    }
    if (session.status === 'closed') {
      throw new Error('Work Session ' + session.id + ' is closed.');
    }
    if (session.status === 'expired') {
      throw new Error('Work Session ' + session.id + ' is expired.');
    }
  }

  async create(input: WorkSessionCreateInput = {}): Promise<WorkSession> {
    const principalId = this.principalId();
    const name = boundedText(input.name, 'name', 128);
    const workspace = boundedText(input.workspace, 'workspace', 128);
    const projectPath = boundedText(input.projectPath, 'projectPath', 1024);
    const objective = boundedText(input.objective, 'objective', 2048);
    const role = boundedText(input.role, 'role', 256);
    const lifecyclePolicy = normalizeLifecyclePolicy(input.idleAfterMinutes, input.expireAfterMinutes);

    return this.mutate(async () => {
      const state = await this.load();
      const timestamp = this.now().toISOString();
      const capsule: ContextCapsule = {
        version: 1,
        ...(workspace ? { project: { workspace, ...(projectPath ? { projectPath } : {}) } } : {}),
        ...(objective ? { currentObjective: objective } : {}),
        ...(role ? { role } : {}),
        validatedFacts: [],
        completedTasks: [],
        blockers: [],
        decisions: [],
        resourceState: [],
        pendingActions: []
      };
      const session: WorkSession = {
        version: 1,
        id: randomUUID(),
        principalId,
        status: 'created',
        ...(name ? { name } : {}),
        createdAt: timestamp,
        updatedAt: timestamp,
        lastActivityAt: timestamp,
        ...(lifecyclePolicy ? { lifecyclePolicy } : {}),
        capsule
      };
      state.sessions.push(session);
      await this.save(state);
      return structuredClone(session);
    });
  }

  async touch(sessionId: string): Promise<WorkSession> {
    const normalized = sessionId.trim();
    if (!normalized) throw new Error('Work Session id must not be empty.');
    return this.mutate(async () => {
      const state = await this.load();
      const session = this.findOwned(state, normalized);
      if (!session) throw new Error('Unknown Work Session ' + normalized + '.');
      const now = this.now();
      this.applyTimeouts(session, now);
      this.assertUsable(session);
      if (session.status === 'created' || session.status === 'idle' || session.status === 'recovering') {
        session.status = session.capsule.blockers.length > 0 ? 'blocked' : 'active';
        delete session.lifecycleReason;
      }
      session.lastActivityAt = now.toISOString();
      session.updatedAt = now.toISOString();
      await this.save(state);
      return structuredClone(session);
    });
  }

  async resume(sessionId: string): Promise<WorkSession> {
    return this.inspect(sessionId, true);
  }

  async inspect(sessionId: string, includeTerminal = true): Promise<WorkSession> {
    const normalized = sessionId.trim();
    if (!normalized) throw new Error('Work Session id must not be empty.');
    const state = await this.load();
    const session = this.findOwned(state, normalized);
    if (!session) throw new Error('Unknown Work Session ' + normalized + '.');
    const snapshot = this.snapshotWithTimeouts(session);
    if (!includeTerminal && isTerminal(snapshot.status)) {
      throw new Error('Work Session ' + normalized + ' is ' + snapshot.status + '.');
    }
    return snapshot;
  }

  async checkpoint(
    sessionId: string,
    patch: WorkSessionCheckpointInput
  ): Promise<WorkSession> {
    const normalized = sessionId.trim();
    if (!normalized) throw new Error('Work Session id must not be empty.');

    return this.mutate(async () => {
      const state = await this.load();
      const session = this.findOwned(state, normalized);
      if (!session) throw new Error('Unknown Work Session ' + normalized + '.');
      const now = this.now();
      this.applyTimeouts(session, now);
      this.assertUsable(session);

      const next: ContextCapsule = {
        ...session.capsule,
        ...(patch.currentObjective !== undefined ? { currentObjective: boundedText(patch.currentObjective, 'currentObjective', 2048) } : {}),
        ...(patch.role !== undefined ? { role: boundedText(patch.role, 'role', 256) } : {}),
        ...(patch.selectedProvider !== undefined ? { selectedProvider: boundedText(patch.selectedProvider, 'selectedProvider', 256) } : {}),
        ...(patch.selectedToolchain !== undefined ? { selectedToolchain: boundedText(patch.selectedToolchain, 'selectedToolchain', 256) } : {}),
        ...(patch.selectedVariant !== undefined ? { selectedVariant: boundedText(patch.selectedVariant, 'selectedVariant', 256) } : {}),
        ...(patch.currentTask !== undefined ? { currentTask: boundedText(patch.currentTask, 'currentTask', 512) } : {}),
        ...(patch.lastSuccessfulBuild !== undefined ? { lastSuccessfulBuild: boundedText(patch.lastSuccessfulBuild, 'lastSuccessfulBuild', 1024) } : {}),
        ...(patch.lastSuccessfulDeploy !== undefined ? { lastSuccessfulDeploy: boundedText(patch.lastSuccessfulDeploy, 'lastSuccessfulDeploy', 1024) } : {}),
        ...(patch.lastAcceptance !== undefined ? { lastAcceptance: boundedText(patch.lastAcceptance, 'lastAcceptance', 1024) } : {}),
        ...(patch.nextRecommendedEngineeringAction !== undefined ? {
          nextRecommendedEngineeringAction: boundedText(
            patch.nextRecommendedEngineeringAction,
            'nextRecommendedEngineeringAction',
            1024
          )
        } : {}),
        ...(patch.validatedFacts !== undefined ? { validatedFacts: boundedList(patch.validatedFacts, 'validatedFacts')! } : {}),
        ...(patch.completedTasks !== undefined ? { completedTasks: boundedList(patch.completedTasks, 'completedTasks', 64, 512)! } : {}),
        ...(patch.blockers !== undefined ? { blockers: boundedList(patch.blockers, 'blockers')! } : {}),
        ...(patch.decisions !== undefined ? { decisions: boundedList(patch.decisions, 'decisions')! } : {}),
        ...(patch.resourceState !== undefined ? { resourceState: boundedList(patch.resourceState, 'resourceState')! } : {}),
        ...(patch.pendingActions !== undefined ? { pendingActions: boundedList(patch.pendingActions, 'pendingActions')! } : {})
      };
      for (const key of [
        'currentObjective',
        'role',
        'selectedProvider',
        'selectedToolchain',
        'selectedVariant',
        'currentTask',
        'lastSuccessfulBuild',
        'lastSuccessfulDeploy',
        'lastAcceptance',
        'nextRecommendedEngineeringAction'
      ] as const) {
        if (next[key] === undefined) delete next[key];
      }
      session.capsule = next;
      session.status = next.blockers.length > 0 ? 'blocked' : 'active';
      delete session.lifecycleReason;
      session.lastActivityAt = now.toISOString();
      session.updatedAt = now.toISOString();
      await this.save(state);
      return structuredClone(session);
    });
  }

  async updateProject(
    sessionId: string,
    patch: Partial<ContextCapsuleProject>,
    options: { allowTerminal?: boolean } = {}
  ): Promise<WorkSession> {
    const normalized = sessionId.trim();
    if (!normalized) throw new Error('Work Session id must not be empty.');

    return this.mutate(async () => {
      const state = await this.load();
      const session = this.findOwned(state, normalized);
      if (!session) throw new Error('Unknown Work Session ' + normalized + '.');
      const now = this.now();
      this.applyTimeouts(session, now);
      if (!options.allowTerminal) this.assertUsable(session);

      const existing = session.capsule.project;
      const workspace = boundedText(patch.workspace ?? existing?.workspace, 'workspace', 128);
      if (!workspace) throw new Error('Context Capsule project workspace is required.');

      const merged: ContextCapsuleProject = {
        ...(existing ?? { workspace }),
        ...patch,
        workspace
      };
      for (const key of Object.keys(merged) as Array<keyof ContextCapsuleProject>) {
        if (merged[key] === undefined) delete merged[key];
      }
      session.capsule.project = merged;
      if (session.status === 'created' || session.status === 'idle' || session.status === 'recovering') {
        session.status = session.capsule.blockers.length > 0 ? 'blocked' : 'active';
      }
      delete session.lifecycleReason;
      session.lastActivityAt = now.toISOString();
      session.updatedAt = now.toISOString();
      await this.save(state);
      return structuredClone(session);
    });
  }

  async beginClose(sessionId: string): Promise<WorkSession> {
    const normalized = sessionId.trim();
    if (!normalized) throw new Error('Work Session id must not be empty.');
    return this.mutate(async () => {
      const state = await this.load();
      const session = this.findOwned(state, normalized);
      if (!session) throw new Error('Unknown Work Session ' + normalized + '.');
      const now = this.now();
      this.applyTimeouts(session, now);
      this.assertUsable(session);
      session.status = 'closing';
      session.updatedAt = now.toISOString();
      session.lastActivityAt = now.toISOString();
      session.lifecycleReason = 'CLOSE_PREFLIGHT';
      await this.save(state);
      return structuredClone(session);
    });
  }

  async abortClose(sessionId: string, reason: string): Promise<WorkSession> {
    const normalizedReason = boundedText(reason, 'lifecycleReason', 512) ?? 'CLOSE_ABORTED';
    return this.mutate(async () => {
      const state = await this.load();
      const session = this.findOwned(state, sessionId);
      if (!session) throw new Error('Unknown Work Session ' + sessionId + '.');
      if (session.status !== 'closing' && session.status !== 'recovering') {
        throw new Error('Work Session ' + sessionId + ' is not closing or recovering.');
      }
      const now = this.now().toISOString();
      session.status = session.capsule.blockers.length > 0 ? 'blocked' : 'active';
      session.lifecycleReason = normalizedReason;
      session.updatedAt = now;
      session.lastActivityAt = now;
      await this.save(state);
      return structuredClone(session);
    });
  }

  async markRecovering(sessionId: string, reason: string): Promise<WorkSession> {
    const normalizedReason = boundedText(reason, 'lifecycleReason', 512) ?? 'RECOVERY_REQUIRED';
    return this.mutate(async () => {
      const state = await this.load();
      const session = this.findOwned(state, sessionId);
      if (!session) throw new Error('Unknown Work Session ' + sessionId + '.');
      if (isTerminal(session.status)) return structuredClone(session);
      session.status = 'recovering';
      session.lifecycleReason = normalizedReason;
      session.updatedAt = this.now().toISOString();
      await this.save(state);
      return structuredClone(session);
    });
  }

  async completeClose(sessionId: string): Promise<WorkSession> {
    return this.mutate(async () => {
      const state = await this.load();
      const session = this.findOwned(state, sessionId);
      if (!session) throw new Error('Unknown Work Session ' + sessionId + '.');
      if (session.status !== 'closing') {
        throw new Error('Work Session ' + sessionId + ' is not closing.');
      }
      const now = this.now().toISOString();
      session.status = 'closed';
      session.closedAt = now;
      session.updatedAt = now;
      session.lastActivityAt = now;
      delete session.lifecycleReason;
      await this.save(state);
      return structuredClone(session);
    });
  }

  async reconcileLifecycle(): Promise<WorkSessionReconciliationResult> {
    return this.mutate(async () => {
      const state = await this.load();
      const result: WorkSessionReconciliationResult = { recovered: 0, idled: 0, expired: 0 };
      const now = this.now();
      let changed = false;
      for (const session of state.sessions) {
        if (session.status === 'active' || session.status === 'closing') {
          const previousStatus = session.status;
          session.status = 'recovering';
          session.lifecycleReason = previousStatus === 'closing'
            ? 'INTERRUPTED_CLOSE'
            : 'RUNTIME_RESTART';
          session.updatedAt = now.toISOString();
          result.recovered += 1;
          changed = true;
        }
        const transition = this.applyTimeouts(session, now);
        if (transition === 'idle') {
          result.idled += 1;
          changed = true;
        } else if (transition === 'expired') {
          result.expired += 1;
          changed = true;
        }
      }
      if (changed) await this.save(state);
      return result;
    });
  }

  async garbageCollect(): Promise<WorkSessionGarbageCollectionResult> {
    return this.mutate(async () => {
      const state = await this.load();
      const nowMs = this.now().getTime();
      let removed = 0;
      let retainedWithWorktree = 0;
      const keep: WorkSession[] = [];
      for (const session of state.sessions) {
        const terminalAt = Date.parse(session.closedAt ?? session.expiredAt ?? session.updatedAt);
        const eligible = isTerminal(session.status) && nowMs - terminalAt >= this.terminalRetentionMs;
        if (!eligible || removed >= this.gcMaxRecords) {
          keep.push(session);
          continue;
        }
        if (session.capsule.project?.worktreePath) {
          retainedWithWorktree += 1;
          keep.push(session);
          continue;
        }
        removed += 1;
      }
      if (removed > 0) {
        state.sessions = keep;
        await this.save(state);
      }
      return { removed, retainedWithWorktree };
    });
  }

  async list(includeClosed = false): Promise<WorkSession[]> {
    const principalId = this.principalId();
    const state = await this.load();
    const now = this.now();
    return state.sessions
      .filter(item => item.principalId === principalId)
      .map(item => this.snapshotWithTimeouts(item, now))
      .filter(item => includeClosed || (item.status !== 'closed' && item.status !== 'expired'));
  }
}
