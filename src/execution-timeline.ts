import type { TaskAttemptRecord, TaskAttemptStore, TaskProviderAttemptRecord } from './task-attempt-store.js';
import type { TaskGraphStore, WorkTask } from './task-graph.js';

export type ExecutionTimelineStepKind =
  | 'attempt-started'
  | 'provider-running'
  | 'provider-finished'
  | 'cancellation-requested'
  | 'attempt-finished';

export interface ExecutionTimelineStep {
  kind: ExecutionTimelineStepKind;
  status: 'running' | 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'interrupted' | 'requested';
  at: string;
  providerId?: string;
  providerRunId?: string;
  summary?: string;
}

export interface ExecutionTimelineEntry {
  attemptId: string;
  taskId: string;
  taskTitle: string;
  generation: number;
  taskStatus: WorkTask['status'];
  attemptStatus: TaskAttemptRecord['status'];
  plannedTarget?: string;
  selectedTarget?: string;
  fallbackUsed: boolean;
  directRwmcpHandoff: boolean;
  cancellationRequested: boolean;
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
  error?: string;
  steps: ExecutionTimelineStep[];
}

export interface ExecutionTimelineResult {
  objective: { id: string; name: string; status: string; workSessionId: string };
  active: ExecutionTimelineEntry[];
  history: ExecutionTimelineEntry[];
  generatedAt: string;
  semantics: {
    mechanicallyDerived: true;
    recommendation: false;
    authority: 'read-only-execution-evidence';
    progressModel: 'stage-only';
  };
}

function plannedTarget(task: WorkTask): string | undefined {
  if (task.execution?.kind === 'worker-provider') return task.execution.providerId;
  if (task.execution?.kind === 'engineering-workflow') return `workflow:${task.execution.workflow}`;
  return undefined;
}

function providerSteps(attempt: TaskAttemptRecord): ExecutionTimelineStep[] {
  const steps: ExecutionTimelineStep[] = [{
    kind: 'attempt-started',
    status: 'running',
    at: attempt.startedAt
  }];
  const providerAttempts = attempt.providerAttempts ?? [];
  for (const provider of providerAttempts) {
    steps.push({
      kind: 'provider-finished',
      status: provider.status,
      at: attempt.updatedAt,
      providerId: provider.providerId,
      ...(provider.providerRunId ? { providerRunId: provider.providerRunId } : {}),
      ...(provider.summary ? { summary: provider.summary } : {})
    });
  }
  if (attempt.status === 'running' && attempt.providerId && !providerAttempts.some(item => item.providerId === attempt.providerId)) {
    steps.push({
      kind: 'provider-running',
      status: 'running',
      at: attempt.updatedAt,
      providerId: attempt.providerId,
      ...(attempt.providerRunId ? { providerRunId: attempt.providerRunId } : {})
    });
  }
  if (attempt.cancelRequestedAt) {
    steps.push({
      kind: 'cancellation-requested',
      status: 'requested',
      at: attempt.cancelRequestedAt,
      ...(attempt.providerId ? { providerId: attempt.providerId } : {})
    });
  }
  if (attempt.status !== 'running') {
    steps.push({
      kind: 'attempt-finished',
      status: attempt.status,
      at: attempt.endedAt ?? attempt.updatedAt,
      ...(attempt.providerId ? { providerId: attempt.providerId } : {}),
      ...(attempt.providerRunId ? { providerRunId: attempt.providerRunId } : {}),
      ...(attempt.error ? { summary: attempt.error } : {})
    });
  }
  return steps;
}

function compactEntry(task: WorkTask, attempt: TaskAttemptRecord): ExecutionTimelineEntry {
  const providerAttempts: TaskProviderAttemptRecord[] = attempt.providerAttempts ?? [];
  const planned = plannedTarget(task);
  const selected = attempt.providerId;
  const distinctProviders = [...new Set(providerAttempts.map(item => item.providerId))];
  const fallbackUsed = distinctProviders.length > 1 || Boolean(planned && selected && planned !== selected);
  return {
    attemptId: attempt.id,
    taskId: task.id,
    taskTitle: task.title,
    generation: attempt.generation,
    taskStatus: task.status,
    attemptStatus: attempt.status,
    ...(planned ? { plannedTarget: planned } : {}),
    ...(selected ? { selectedTarget: selected } : {}),
    fallbackUsed,
    directRwmcpHandoff: providerAttempts.some(item => item.providerId === 'rwmcp-direct'),
    cancellationRequested: Boolean(attempt.cancelRequestedAt),
    startedAt: attempt.startedAt,
    updatedAt: attempt.updatedAt,
    ...(attempt.endedAt ? { endedAt: attempt.endedAt } : {}),
    ...(attempt.error ? { error: attempt.error } : {}),
    steps: providerSteps(attempt)
  };
}

export class ExecutionTimelineService {
  constructor(
    private readonly taskGraphs: TaskGraphStore,
    private readonly taskAttempts: TaskAttemptStore,
    private readonly now: () => Date = () => new Date()
  ) {}

  async timeline(
    objectiveId: string,
    options: { taskId?: string; limit?: number } = {}
  ): Promise<ExecutionTimelineResult> {
    const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
    const [objective, attempts] = await Promise.all([
      this.taskGraphs.get(objectiveId),
      this.taskAttempts.list({ objectiveId, taskId: options.taskId, limit })
    ]);
    const taskById = new Map(objective.tasks.map(task => [task.id, task]));
    const entries = attempts
      .map(attempt => {
        const task = taskById.get(attempt.taskId);
        return task ? compactEntry(task, attempt) : undefined;
      })
      .filter((entry): entry is ExecutionTimelineEntry => Boolean(entry));
    return {
      objective: {
        id: objective.id,
        name: objective.name,
        status: objective.status,
        workSessionId: objective.workSessionId
      },
      active: entries.filter(entry => entry.attemptStatus === 'running'),
      history: entries,
      generatedAt: this.now().toISOString(),
      semantics: {
        mechanicallyDerived: true,
        recommendation: false,
        authority: 'read-only-execution-evidence',
        progressModel: 'stage-only'
      }
    };
  }
}
