import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveResourceOwner, type ResourceOwnerSource } from './security/execution-context.js';
import { setupConfigDir } from './setup/settings.js';

export type TaskAttemptStatus =
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'blocked'
  | 'cancelled'
  | 'interrupted';

export interface TaskAttemptRecord {
  version: 1;
  id: string;
  principalId: string;
  workSessionId: string;
  objectiveId: string;
  taskId: string;
  generation: number;
  status: TaskAttemptStatus;
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
  cancelRequestedAt?: string;
  workflowRunId?: string;
  error?: string;
}

interface TaskAttemptFileV1 {
  version: 1;
  attempts: TaskAttemptRecord[];
}

export interface TaskAttemptStoreOptions {
  file?: string;
  now?: () => Date;
  maxRecords?: number;
}

function bounded(value: string, field: string, max: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max || normalized.includes('\0')) {
    throw new Error(`${field} must be non-empty text of at most ${max} characters.`);
  }
  return normalized;
}

function boundedGeneration(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000) {
    throw new Error('generation must be an integer between 1 and 1000000.');
  }
  return value;
}

export class TaskAttemptStore {
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly file: string;
  private readonly now: () => Date;
  private readonly maxRecords: number;

  constructor(
    private readonly ownerSource: ResourceOwnerSource = 'unknown',
    options: TaskAttemptStoreOptions = {}
  ) {
    this.file = options.file ?? path.join(setupConfigDir(), 'task-attempts.json');
    this.now = options.now ?? (() => new Date());
    this.maxRecords = Math.max(100, Math.min(options.maxRecords ?? 5000, 20_000));
  }

  private owner() {
    const owner = resolveResourceOwner(this.ownerSource);
    if (owner.implicit) {
      throw new Error('Task Attempt operations require an explicit Work Session.');
    }
    return owner;
  }

  private readonly validRecord = (value: unknown): value is TaskAttemptRecord => {
    if (!value || typeof value !== 'object') return false;
    const item = value as Partial<TaskAttemptRecord>;
    return item.version === 1 &&
      typeof item.id === 'string' &&
      typeof item.principalId === 'string' &&
      typeof item.workSessionId === 'string' &&
      typeof item.objectiveId === 'string' &&
      typeof item.taskId === 'string' &&
      typeof item.generation === 'number' &&
      Number.isSafeInteger(item.generation) &&
      item.generation >= 1 &&
      ['running', 'succeeded', 'failed', 'blocked', 'cancelled', 'interrupted'].includes(item.status ?? '') &&
      typeof item.startedAt === 'string' &&
      typeof item.updatedAt === 'string' &&
      (item.endedAt === undefined || typeof item.endedAt === 'string') &&
      (item.cancelRequestedAt === undefined || typeof item.cancelRequestedAt === 'string') &&
      (item.workflowRunId === undefined || typeof item.workflowRunId === 'string') &&
      (item.error === undefined || typeof item.error === 'string');
  };

  private async load(): Promise<TaskAttemptFileV1> {
    try {
      const parsed = JSON.parse((await fs.readFile(this.file, 'utf8')).replace(/^\uFEFF/, '')) as Partial<TaskAttemptFileV1>;
      if (parsed.version !== 1 || !Array.isArray(parsed.attempts)) {
        throw new Error(`Invalid Task Attempt store at '${this.file}'.`);
      }
      return { version: 1, attempts: parsed.attempts.filter(this.validRecord) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, attempts: [] };
      throw error;
    }
  }

  private async save(state: TaskAttemptFileV1): Promise<void> {
    if (state.attempts.length > this.maxRecords) {
      const running = state.attempts.filter(item => item.status === 'running');
      const terminal = state.attempts.filter(item => item.status !== 'running');
      const terminalBudget = Math.max(0, this.maxRecords - running.length);
      const keepTerminalIds = new Set(
        (terminalBudget > 0 ? terminal.slice(-terminalBudget) : []).map(item => item.id)
      );
      state.attempts = state.attempts.filter(item =>
        item.status === 'running' || keepTerminalIds.has(item.id)
      );
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

  private owned(
    state: TaskAttemptFileV1,
    objectiveId: string,
    taskId: string,
    generation: number
  ): TaskAttemptRecord | undefined {
    const owner = this.owner();
    const objective = bounded(objectiveId, 'objectiveId', 64);
    const task = bounded(taskId, 'taskId', 64);
    const gen = boundedGeneration(generation);
    return state.attempts.find(item =>
      item.principalId === owner.principalId &&
      item.workSessionId === owner.workSessionId &&
      item.objectiveId === objective &&
      item.taskId === task &&
      item.generation === gen
    );
  }

  async begin(
    objectiveId: string,
    taskId: string,
    generation: number
  ): Promise<{ attempt: TaskAttemptRecord; created: boolean }> {
    const owner = this.owner();
    const objective = bounded(objectiveId, 'objectiveId', 64);
    const task = bounded(taskId, 'taskId', 64);
    const gen = boundedGeneration(generation);
    return this.mutate(async () => {
      const state = await this.load();
      const existing = state.attempts.find(item =>
        item.principalId === owner.principalId &&
        item.workSessionId === owner.workSessionId &&
        item.objectiveId === objective &&
        item.taskId === task &&
        item.generation === gen
      );
      if (existing) return { attempt: structuredClone(existing), created: false };

      const timestamp = this.now().toISOString();
      const attempt: TaskAttemptRecord = {
        version: 1,
        id: randomUUID(),
        principalId: owner.principalId,
        workSessionId: owner.workSessionId,
        objectiveId: objective,
        taskId: task,
        generation: gen,
        status: 'running',
        startedAt: timestamp,
        updatedAt: timestamp
      };
      state.attempts.push(attempt);
      await this.save(state);
      return { attempt: structuredClone(attempt), created: true };
    });
  }

  async recordCancelled(
    objectiveId: string,
    taskId: string,
    generation: number,
    reason = 'cancelled-before-dispatch'
  ): Promise<TaskAttemptRecord> {
    const owner = this.owner();
    const objective = bounded(objectiveId, 'objectiveId', 64);
    const task = bounded(taskId, 'taskId', 64);
    const gen = boundedGeneration(generation);
    return this.mutate(async () => {
      const state = await this.load();
      const existing = state.attempts.find(item =>
        item.principalId === owner.principalId &&
        item.workSessionId === owner.workSessionId &&
        item.objectiveId === objective &&
        item.taskId === task &&
        item.generation === gen
      );
      if (existing) return structuredClone(existing);
      const timestamp = this.now().toISOString();
      const attempt: TaskAttemptRecord = {
        version: 1,
        id: randomUUID(),
        principalId: owner.principalId,
        workSessionId: owner.workSessionId,
        objectiveId: objective,
        taskId: task,
        generation: gen,
        status: 'cancelled',
        startedAt: timestamp,
        updatedAt: timestamp,
        endedAt: timestamp,
        cancelRequestedAt: timestamp,
        error: bounded(reason, 'reason', 1024)
      };
      state.attempts.push(attempt);
      await this.save(state);
      return structuredClone(attempt);
    });
  }

  async requestCancellation(
    objectiveId: string,
    taskId: string,
    generation: number
  ): Promise<TaskAttemptRecord | undefined> {
    return this.mutate(async () => {
      const state = await this.load();
      const attempt = this.owned(state, objectiveId, taskId, generation);
      if (!attempt) return undefined;
      if (attempt.status !== 'running') return structuredClone(attempt);
      if (!attempt.cancelRequestedAt) {
        const timestamp = this.now().toISOString();
        attempt.cancelRequestedAt = timestamp;
        attempt.updatedAt = timestamp;
        await this.save(state);
      }
      return structuredClone(attempt);
    });
  }

  async finish(
    attemptId: string,
    status: Exclude<TaskAttemptStatus, 'running'>,
    options: { error?: string; workflowRunId?: string } = {}
  ): Promise<TaskAttemptRecord> {
    const owner = this.owner();
    const normalizedId = bounded(attemptId, 'attemptId', 64);
    return this.mutate(async () => {
      const state = await this.load();
      const attempt = state.attempts.find(item =>
        item.id === normalizedId &&
        item.principalId === owner.principalId &&
        item.workSessionId === owner.workSessionId
      );
      if (!attempt) throw new Error(`Unknown Task Attempt '${normalizedId}'.`);
      if (attempt.status !== 'running') return structuredClone(attempt);
      const timestamp = this.now().toISOString();
      attempt.status = status;
      attempt.updatedAt = timestamp;
      attempt.endedAt = timestamp;
      const error = options.error?.trim().slice(0, 1024);
      if (error) attempt.error = error;
      const workflowRunId = options.workflowRunId?.trim();
      if (workflowRunId) attempt.workflowRunId = bounded(workflowRunId, 'workflowRunId', 64);
      await this.save(state);
      return structuredClone(attempt);
    });
  }

  async getForGeneration(
    objectiveId: string,
    taskId: string,
    generation: number
  ): Promise<TaskAttemptRecord | undefined> {
    const state = await this.load();
    const attempt = this.owned(state, objectiveId, taskId, generation);
    return attempt ? structuredClone(attempt) : undefined;
  }

  async list(options: {
    objectiveId?: string;
    taskId?: string;
    limit?: number;
  } = {}): Promise<TaskAttemptRecord[]> {
    const owner = this.owner();
    const objectiveId = options.objectiveId?.trim();
    const taskId = options.taskId?.trim();
    const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
    const state = await this.load();
    return state.attempts
      .filter(item =>
        item.principalId === owner.principalId &&
        item.workSessionId === owner.workSessionId &&
        (!objectiveId || item.objectiveId === objectiveId) &&
        (!taskId || item.taskId === taskId)
      )
      .slice(-limit)
      .reverse()
      .map(item => structuredClone(item));
  }

  async reconcileInterrupted(
    reason = 'runtime-restarted-before-task-attempt-completion'
  ): Promise<TaskAttemptRecord[]> {
    return this.mutate(async () => {
      const state = await this.load();
      const timestamp = this.now().toISOString();
      const reconciled: TaskAttemptRecord[] = [];
      for (const attempt of state.attempts) {
        if (attempt.status !== 'running') continue;
        attempt.status = 'interrupted';
        attempt.updatedAt = timestamp;
        attempt.endedAt = timestamp;
        attempt.error = reason.slice(0, 1024);
        reconciled.push(structuredClone(attempt));
      }
      if (reconciled.length > 0) await this.save(state);
      return reconciled;
    });
  }
}
