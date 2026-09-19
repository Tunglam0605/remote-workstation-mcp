import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ConcurrencyPolicy, type ConcurrencyDecision, type ConcurrencyOperation } from './concurrency-policy.js';
import { resolveResourceOwner, type ResourceOwnerSource } from './security/execution-context.js';
import { setupConfigDir } from './setup/settings.js';

export type WorkObjectiveStatus = 'active' | 'succeeded' | 'failed' | 'blocked';
export type WorkTaskStatus = 'pending' | 'ready' | 'running' | 'succeeded' | 'failed' | 'blocked';

export interface WorkTaskConcurrency {
  operation?: ConcurrencyOperation;
  key?: string;
}

export interface WorkTask {
  version: 1;
  id: string;
  objectiveId: string;
  sequence: number;
  title: string;
  description?: string;
  priority: number;
  status: WorkTaskStatus;
  dependencies: string[];
  concurrency: WorkTaskConcurrency;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  endedAt?: string;
  error?: string;
}

export interface WorkObjective {
  version: 1;
  id: string;
  principalId: string;
  workSessionId: string;
  name: string;
  objective: string;
  status: WorkObjectiveStatus;
  createdAt: string;
  updatedAt: string;
  tasks: WorkTask[];
}

interface TaskGraphFileV1 {
  version: 1;
  objectives: WorkObjective[];
}

export interface WorkObjectiveCreateInput {
  name: string;
  objective: string;
}

export interface WorkTaskCreateInput {
  title: string;
  description?: string;
  priority?: number;
  dependencies?: string[];
  concurrency?: WorkTaskConcurrency;
}

export interface TaskGraphStoreOptions {
  file?: string;
  now?: () => Date;
  maxObjectives?: number;
  maxTasksPerObjective?: number;
}

export interface ScheduledTask {
  task: WorkTask;
  concurrencyDecision?: ConcurrencyDecision;
  dispatchable: boolean;
  blocker?: 'OWNER_LOCAL_ONLY' | 'CONCURRENCY_KEY_REQUIRED' | 'CONCURRENCY_OPERATION_REQUIRED';
  requiresLeaseCheck: boolean;
}

function bounded(value: string, field: string, max: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max || normalized.includes('\0')) {
    throw new Error(`${field} must be non-empty text of at most ${max} characters.`);
  }
  return normalized;
}

function boundedOptional(value: string | undefined, field: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (normalized.length > max || normalized.includes('\0')) {
    throw new Error(`${field} must be text of at most ${max} characters.`);
  }
  return normalized;
}

function boundedPriority(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < -1000 || value > 1000) {
    throw new Error('priority must be an integer between -1000 and 1000.');
  }
  return value;
}

function uniqueDependencies(values: string[] | undefined): string[] {
  if (!values) return [];
  if (values.length > 64) throw new Error('dependencies accepts at most 64 task ids.');
  const normalized = values.map((value, index) => bounded(value, `dependencies[${index}]`, 64));
  if (new Set(normalized).size !== normalized.length) {
    throw new Error('dependencies must not contain duplicate task ids.');
  }
  return normalized;
}

function validateTask(value: unknown): WorkTask {
  if (!value || typeof value !== 'object') throw new Error('Invalid Work Task record.');
  const task = value as Partial<WorkTask>;
  if (
    task.version !== 1 ||
    typeof task.id !== 'string' ||
    typeof task.objectiveId !== 'string' ||
    !Number.isSafeInteger(task.sequence) ||
    typeof task.title !== 'string' ||
    !Number.isSafeInteger(task.priority) ||
    !['pending', 'ready', 'running', 'succeeded', 'failed', 'blocked'].includes(task.status ?? '') ||
    !Array.isArray(task.dependencies) ||
    !task.dependencies.every(item => typeof item === 'string') ||
    !task.concurrency ||
    typeof task.concurrency !== 'object' ||
    typeof task.createdAt !== 'string' ||
    typeof task.updatedAt !== 'string'
  ) {
    throw new Error('Invalid Work Task record.');
  }
  return task as WorkTask;
}

function validateObjective(value: unknown): WorkObjective {
  if (!value || typeof value !== 'object') throw new Error('Invalid Work Objective record.');
  const objective = value as Partial<WorkObjective>;
  if (
    objective.version !== 1 ||
    typeof objective.id !== 'string' ||
    typeof objective.principalId !== 'string' ||
    typeof objective.workSessionId !== 'string' ||
    typeof objective.name !== 'string' ||
    typeof objective.objective !== 'string' ||
    !['active', 'succeeded', 'failed', 'blocked'].includes(objective.status ?? '') ||
    typeof objective.createdAt !== 'string' ||
    typeof objective.updatedAt !== 'string' ||
    !Array.isArray(objective.tasks)
  ) {
    throw new Error('Invalid Work Objective record.');
  }
  const tasks = objective.tasks.map(validateTask);
  if (tasks.some(task => task.objectiveId !== objective.id)) {
    throw new Error('Work Task objectiveId does not match its containing Work Objective.');
  }
  return { ...(objective as WorkObjective), tasks };
}

function assertAcyclic(tasks: WorkTask[]): void {
  const byId = new Map(tasks.map(task => [task.id, task]));
  for (const task of tasks) {
    for (const dependency of task.dependencies) {
      if (!byId.has(dependency)) {
        throw new Error(`Task '${task.id}' depends on unknown task '${dependency}'.`);
      }
      if (dependency === task.id) throw new Error(`Task '${task.id}' cannot depend on itself.`);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (taskId: string): void => {
    if (visited.has(taskId)) return;
    if (visiting.has(taskId)) throw new Error(`Task dependency cycle detected at '${taskId}'.`);
    visiting.add(taskId);
    for (const dependency of byId.get(taskId)?.dependencies ?? []) visit(dependency);
    visiting.delete(taskId);
    visited.add(taskId);
  };
  for (const task of tasks) visit(task.id);
}

function normalizeGraph(objective: WorkObjective, timestamp: string): void {
  assertAcyclic(objective.tasks);
  const byId = new Map(objective.tasks.map(task => [task.id, task]));

  let changed = true;
  while (changed) {
    changed = false;
    for (const task of objective.tasks) {
      if (['running', 'succeeded', 'failed'].includes(task.status)) continue;
      const deps = task.dependencies.map(id => byId.get(id)!);
      const shouldBlock = deps.some(dep => dep.status === 'failed' || dep.status === 'blocked');
      const shouldReady = !shouldBlock && deps.every(dep => dep.status === 'succeeded');
      const nextStatus: WorkTaskStatus = shouldBlock ? 'blocked' : shouldReady ? 'ready' : 'pending';
      if (task.status !== nextStatus) {
        task.status = nextStatus;
        task.updatedAt = timestamp;
        if (nextStatus !== 'blocked') delete task.error;
        changed = true;
      }
      if (nextStatus === 'blocked' && !task.error) {
        task.error = 'blocked-by-dependency';
      }
    }
  }

  if (objective.tasks.length === 0) {
    objective.status = 'active';
  } else if (objective.tasks.every(task => task.status === 'succeeded')) {
    objective.status = 'succeeded';
  } else if (objective.tasks.some(task => task.status === 'failed')) {
    objective.status = 'failed';
  } else if (
    objective.tasks.every(task => ['succeeded', 'blocked'].includes(task.status)) &&
    objective.tasks.some(task => task.status === 'blocked')
  ) {
    objective.status = 'blocked';
  } else {
    objective.status = 'active';
  }
  objective.updatedAt = timestamp;
}

export class TaskGraphStore {
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly file: string;
  private readonly now: () => Date;
  private readonly maxObjectives: number;
  private readonly maxTasksPerObjective: number;

  constructor(
    private readonly ownerSource: ResourceOwnerSource = 'unknown',
    options: TaskGraphStoreOptions = {}
  ) {
    this.file = options.file ?? path.join(setupConfigDir(), 'work-objectives.json');
    this.now = options.now ?? (() => new Date());
    this.maxObjectives = Math.max(10, Math.min(options.maxObjectives ?? 500, 5000));
    this.maxTasksPerObjective = Math.max(10, Math.min(options.maxTasksPerObjective ?? 500, 5000));
  }

  private owner() {
    const owner = resolveResourceOwner(this.ownerSource);
    if (owner.implicit) {
      throw new Error('Work Objective operations require an explicit Work Session.');
    }
    return owner;
  }

  private async load(): Promise<TaskGraphFileV1> {
    try {
      const parsed = JSON.parse((await fs.readFile(this.file, 'utf8')).replace(/^\uFEFF/, '')) as Partial<TaskGraphFileV1>;
      if (parsed.version !== 1 || !Array.isArray(parsed.objectives)) {
        throw new Error(`Invalid Task Graph store at '${this.file}'.`);
      }
      return { version: 1, objectives: parsed.objectives.map(validateObjective) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, objectives: [] };
      throw error;
    }
  }

  private async save(state: TaskGraphFileV1): Promise<void> {
    if (state.objectives.length > this.maxObjectives) {
      const removable = state.objectives.filter(item => item.status !== 'active');
      const keepIds = new Set(
        [...state.objectives]
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .slice(0, this.maxObjectives)
          .map(item => item.id)
      );
      if (removable.length > 0) state.objectives = state.objectives.filter(item => keepIds.has(item.id));
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

  private ownedObjective(state: TaskGraphFileV1, objectiveId: string): WorkObjective {
    const owner = this.owner();
    const normalized = bounded(objectiveId, 'objectiveId', 64);
    const objective = state.objectives.find(item =>
      item.id === normalized &&
      item.principalId === owner.principalId &&
      item.workSessionId === owner.workSessionId
    );
    if (!objective) throw new Error(`Unknown Work Objective '${normalized}'.`);
    return objective;
  }

  async create(input: WorkObjectiveCreateInput): Promise<WorkObjective> {
    const owner = this.owner();
    const name = bounded(input.name, 'name', 128);
    const objectiveText = bounded(input.objective, 'objective', 2048);
    return this.mutate(async () => {
      const state = await this.load();
      const timestamp = this.now().toISOString();
      const objective: WorkObjective = {
        version: 1,
        id: randomUUID(),
        principalId: owner.principalId,
        workSessionId: owner.workSessionId,
        name,
        objective: objectiveText,
        status: 'active',
        createdAt: timestamp,
        updatedAt: timestamp,
        tasks: []
      };
      state.objectives.push(objective);
      await this.save(state);
      return structuredClone(objective);
    });
  }

  async addTask(objectiveId: string, input: WorkTaskCreateInput): Promise<WorkTask> {
    return this.mutate(async () => {
      const state = await this.load();
      const objective = this.ownedObjective(state, objectiveId);
      if (objective.tasks.length >= this.maxTasksPerObjective) {
        throw new Error(`Work Objective accepts at most ${this.maxTasksPerObjective} tasks.`);
      }
      const timestamp = this.now().toISOString();
      const task: WorkTask = {
        version: 1,
        id: randomUUID(),
        objectiveId: objective.id,
        sequence: objective.tasks.length + 1,
        title: bounded(input.title, 'title', 256),
        ...(boundedOptional(input.description, 'description', 2048) ? { description: boundedOptional(input.description, 'description', 2048) } : {}),
        priority: boundedPriority(input.priority),
        status: 'pending',
        dependencies: uniqueDependencies(input.dependencies),
        concurrency: {
          ...(input.concurrency?.operation ? { operation: input.concurrency.operation } : {}),
          ...(boundedOptional(input.concurrency?.key, 'concurrency.key', 512) ? { key: boundedOptional(input.concurrency?.key, 'concurrency.key', 512) } : {})
        },
        createdAt: timestamp,
        updatedAt: timestamp
      };
      objective.tasks.push(task);
      normalizeGraph(objective, timestamp);
      await this.save(state);
      return structuredClone(task);
    });
  }

  async replaceDependencies(objectiveId: string, taskId: string, dependencies: string[]): Promise<WorkTask> {
    return this.mutate(async () => {
      const state = await this.load();
      const objective = this.ownedObjective(state, objectiveId);
      const task = objective.tasks.find(item => item.id === bounded(taskId, 'taskId', 64));
      if (!task) throw new Error(`Unknown Work Task '${taskId}'.`);
      if (['running', 'succeeded', 'failed'].includes(task.status)) {
        throw new Error(`Cannot change dependencies while task '${task.id}' is ${task.status}.`);
      }
      const previous = task.dependencies;
      task.dependencies = uniqueDependencies(dependencies);
      try {
        assertAcyclic(objective.tasks);
      } catch (error) {
        task.dependencies = previous;
        throw error;
      }
      const timestamp = this.now().toISOString();
      normalizeGraph(objective, timestamp);
      await this.save(state);
      return structuredClone(task);
    });
  }

  async startTask(objectiveId: string, taskId: string): Promise<WorkTask> {
    return this.mutate(async () => {
      const state = await this.load();
      const objective = this.ownedObjective(state, objectiveId);
      const task = objective.tasks.find(item => item.id === bounded(taskId, 'taskId', 64));
      if (!task) throw new Error(`Unknown Work Task '${taskId}'.`);
      if (task.status !== 'ready') throw new Error(`Work Task '${task.id}' is not ready (status=${task.status}).`);
      const timestamp = this.now().toISOString();
      task.status = 'running';
      task.startedAt = timestamp;
      task.updatedAt = timestamp;
      delete task.endedAt;
      delete task.error;
      normalizeGraph(objective, timestamp);
      await this.save(state);
      return structuredClone(task);
    });
  }

  async finishTask(
    objectiveId: string,
    taskId: string,
    status: 'succeeded' | 'failed',
    error?: string
  ): Promise<WorkTask> {
    return this.mutate(async () => {
      const state = await this.load();
      const objective = this.ownedObjective(state, objectiveId);
      const task = objective.tasks.find(item => item.id === bounded(taskId, 'taskId', 64));
      if (!task) throw new Error(`Unknown Work Task '${taskId}'.`);
      if (task.status !== 'running') throw new Error(`Work Task '${task.id}' is not running (status=${task.status}).`);
      const timestamp = this.now().toISOString();
      task.status = status;
      task.updatedAt = timestamp;
      task.endedAt = timestamp;
      const normalizedError = boundedOptional(error, 'error', 1024);
      if (status === 'failed') task.error = normalizedError ?? 'task-failed';
      else delete task.error;
      normalizeGraph(objective, timestamp);
      await this.save(state);
      return structuredClone(task);
    });
  }

  async reconcileInterrupted(reason = 'runtime-restarted-before-task-completion'): Promise<WorkTask[]> {
    return this.mutate(async () => {
      const state = await this.load();
      const timestamp = this.now().toISOString();
      const reconciled: WorkTask[] = [];
      for (const objective of state.objectives) {
        for (const task of objective.tasks) {
          if (task.status !== 'running') continue;
          task.status = 'failed';
          task.updatedAt = timestamp;
          task.endedAt = timestamp;
          task.error = bounded(reason, 'reason', 1024);
          reconciled.push(structuredClone(task));
        }
        normalizeGraph(objective, timestamp);
      }
      if (reconciled.length > 0) await this.save(state);
      return reconciled;
    });
  }

  async get(objectiveId: string): Promise<WorkObjective> {
    const state = await this.load();
    return structuredClone(this.ownedObjective(state, objectiveId));
  }

  async list(): Promise<WorkObjective[]> {
    const owner = this.owner();
    const state = await this.load();
    return state.objectives
      .filter(item => item.principalId === owner.principalId && item.workSessionId === owner.workSessionId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map(item => structuredClone(item));
  }

  async readyTasks(objectiveId: string): Promise<WorkTask[]> {
    const objective = await this.get(objectiveId);
    return objective.tasks
      .filter(task => task.status === 'ready')
      .sort((a, b) => b.priority - a.priority || a.sequence - b.sequence || a.id.localeCompare(b.id));
  }
}

export class DeterministicTaskScheduler {
  constructor(
    private readonly store: TaskGraphStore,
    private readonly concurrencyPolicy = new ConcurrencyPolicy()
  ) {}

  async plan(objectiveId: string, limit = 32): Promise<ScheduledTask[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128) {
      throw new Error('limit must be an integer between 1 and 128.');
    }
    const ready = (await this.store.readyTasks(objectiveId)).slice(0, limit);
    return ready.map(task => {
      if (!task.concurrency.operation) {
        return {
          task,
          dispatchable: false,
          blocker: 'CONCURRENCY_OPERATION_REQUIRED' as const,
          requiresLeaseCheck: false
        };
      }
      const decision = this.concurrencyPolicy.classify(task.concurrency.operation);
      if (decision.class === 'owner-local-only') {
        return {
          task,
          concurrencyDecision: decision,
          dispatchable: false,
          blocker: 'OWNER_LOCAL_ONLY' as const,
          requiresLeaseCheck: false
        };
      }
      if (decision.keyRequired && !task.concurrency.key) {
        return {
          task,
          concurrencyDecision: decision,
          dispatchable: false,
          blocker: 'CONCURRENCY_KEY_REQUIRED' as const,
          requiresLeaseCheck: false
        };
      }
      return {
        task,
        concurrencyDecision: decision,
        dispatchable: true,
        requiresLeaseCheck: decision.class !== 'shared'
      };
    });
  }
}
