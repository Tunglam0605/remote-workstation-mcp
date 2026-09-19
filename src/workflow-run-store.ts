import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveResourceOwner, type ResourceOwnerSource } from './security/execution-context.js';
import { setupConfigDir } from './setup/settings.js';

export type WorkflowRunStatus = 'running' | 'succeeded' | 'failed' | 'blocked';

export interface WorkflowRunRecord {
  version: 1;
  id: string;
  principalId: string;
  workSessionId: string;
  workspace: string;
  projectPath: string;
  workflow: string;
  status: WorkflowRunStatus;
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
  error?: string;
}

interface WorkflowRunFileV1 {
  version: 1;
  runs: WorkflowRunRecord[];
}

export interface WorkflowRunStoreOptions {
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

export class WorkflowRunStore {
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly file: string;
  private readonly now: () => Date;
  private readonly maxRecords: number;

  constructor(
    private readonly ownerSource: ResourceOwnerSource = 'unknown',
    options: WorkflowRunStoreOptions = {}
  ) {
    this.file = options.file ?? path.join(setupConfigDir(), 'workflow-runs.json');
    this.now = options.now ?? (() => new Date());
    this.maxRecords = Math.max(100, Math.min(options.maxRecords ?? 2000, 10_000));
  }

  private async load(): Promise<WorkflowRunFileV1> {
    try {
      const parsed = JSON.parse((await fs.readFile(this.file, 'utf8')).replace(/^\uFEFF/, '')) as Partial<WorkflowRunFileV1>;
      if (parsed.version !== 1 || !Array.isArray(parsed.runs)) {
        throw new Error(`Invalid workflow run store at '${this.file}'.`);
      }
      return { version: 1, runs: parsed.runs.filter(this.validRecord) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, runs: [] };
      throw error;
    }
  }

  private readonly validRecord = (value: unknown): value is WorkflowRunRecord => {
    if (!value || typeof value !== 'object') return false;
    const item = value as Partial<WorkflowRunRecord>;
    return item.version === 1 &&
      typeof item.id === 'string' &&
      typeof item.principalId === 'string' &&
      typeof item.workSessionId === 'string' &&
      typeof item.workspace === 'string' &&
      typeof item.projectPath === 'string' &&
      typeof item.workflow === 'string' &&
      ['running', 'succeeded', 'failed', 'blocked'].includes(item.status ?? '') &&
      typeof item.startedAt === 'string' &&
      typeof item.updatedAt === 'string';
  };

  private async save(state: WorkflowRunFileV1): Promise<void> {
    if (state.runs.length > this.maxRecords) {
      state.runs = state.runs.slice(-this.maxRecords);
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

  async reconcileInterrupted(reason = 'runtime-restarted-before-completion'): Promise<number> {
    return this.mutate(async () => {
      const state = await this.load();
      const timestamp = this.now().toISOString();
      let count = 0;
      for (const record of state.runs) {
        if (record.status !== 'running') continue;
        record.status = 'failed';
        record.updatedAt = timestamp;
        record.endedAt = timestamp;
        record.error = reason.slice(0, 1024);
        count += 1;
      }
      if (count > 0) await this.save(state);
      return count;
    });
  }

  async begin(workspace: string, projectPath: string, workflow: string): Promise<WorkflowRunRecord> {
    const owner = resolveResourceOwner(this.ownerSource);
    const timestamp = this.now().toISOString();
    const record: WorkflowRunRecord = {
      version: 1,
      id: randomUUID(),
      principalId: owner.principalId,
      workSessionId: owner.workSessionId,
      workspace: bounded(workspace, 'workspace', 128),
      projectPath: bounded(projectPath || '.', 'projectPath', 1024),
      workflow: bounded(workflow, 'workflow', 128),
      status: 'running',
      startedAt: timestamp,
      updatedAt: timestamp
    };
    return this.mutate(async () => {
      const state = await this.load();
      state.runs.push(record);
      await this.save(state);
      return structuredClone(record);
    });
  }

  async finish(
    id: string,
    status: Exclude<WorkflowRunStatus, 'running'>,
    error?: string
  ): Promise<WorkflowRunRecord> {
    const owner = resolveResourceOwner(this.ownerSource);
    return this.mutate(async () => {
      const state = await this.load();
      const record = state.runs.find(item =>
        item.id === id &&
        item.principalId === owner.principalId &&
        item.workSessionId === owner.workSessionId
      );
      if (!record) throw new Error(`Unknown workflow run '${id}'.`);
      if (record.status !== 'running') return structuredClone(record);
      const timestamp = this.now().toISOString();
      record.status = status;
      record.updatedAt = timestamp;
      record.endedAt = timestamp;
      const normalizedError = error?.trim().slice(0, 1024);
      if (normalizedError) record.error = normalizedError;
      await this.save(state);
      return structuredClone(record);
    });
  }

  async get(id: string): Promise<WorkflowRunRecord> {
    const owner = resolveResourceOwner(this.ownerSource);
    const state = await this.load();
    const record = state.runs.find(item =>
      item.id === id &&
      item.principalId === owner.principalId &&
      item.workSessionId === owner.workSessionId
    );
    if (!record) throw new Error(`Unknown workflow run '${id}'.`);
    return structuredClone(record);
  }

  async list(limit = 50): Promise<WorkflowRunRecord[]> {
    const owner = resolveResourceOwner(this.ownerSource);
    const boundedLimit = Math.max(1, Math.min(limit, 200));
    const state = await this.load();
    return state.runs
      .filter(item =>
        item.principalId === owner.principalId &&
        item.workSessionId === owner.workSessionId
      )
      .slice(-boundedLimit)
      .reverse()
      .map(item => structuredClone(item));
  }
}
