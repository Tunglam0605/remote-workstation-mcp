import type { SchedulerAwareTask, SchedulerAwarenessService } from './scheduler-awareness.js';
import type { TaskGraphStore, WorkObjective, WorkTask } from './task-graph.js';
import type { TaskWorkflowExecutionService } from './task-workflow-execution.js';

export interface ObjectiveWaveExecutionInput {
  limit?: number;
  maxParallel?: number;
}

export interface ObjectiveWaveTaskResult {
  taskId: string;
  title: string;
  status: WorkTask['status'];
  error?: string;
}

export interface ObjectiveWaveExecutionResult {
  objectiveId: string;
  selectedTaskIds: string[];
  serializedWorkerTask: boolean;
  results: ObjectiveWaveTaskResult[];
  objectiveStatus: WorkObjective['status'];
  remainingReady: number;
  authority: 'bounded-wave-execution';
  note: string;
}

export interface ObjectiveWaveAwarenessSource {
  snapshot(objectiveId: string, limit?: number): Promise<Awaited<ReturnType<SchedulerAwarenessService['snapshot']>>>;
}

export interface ObjectiveWaveExecutor {
  execute(objectiveId: string, taskId: string): Promise<unknown>;
}

export interface ObjectiveWaveGraphSource {
  get(objectiveId: string): Promise<WorkObjective>;
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number, field: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < min || resolved > max) {
    throw new Error(`${field} must be an integer between ${min} and ${max}.`);
  }
  return resolved;
}

function concurrencyIdentity(item: SchedulerAwareTask): string | undefined {
  const decision = item.concurrencyDecision;
  if (!decision || decision.class === 'shared') return undefined;
  if (decision.class === 'node-exclusive') return 'node-exclusive:*';
  const key = item.task.concurrency.key?.trim();
  return key ? `${decision.class}:${key}` : `${decision.class}:*`;
}

function compatibleWithWave(selected: SchedulerAwareTask[], candidate: SchedulerAwareTask): boolean {
  if (candidate.task.execution?.kind === 'worker-provider') return selected.length === 0;
  if (selected.some(item => item.task.execution?.kind === 'worker-provider')) return false;
  const candidateIdentity = concurrencyIdentity(candidate);
  if (candidateIdentity === 'node-exclusive:*') return selected.length === 0;
  if (selected.some(item => concurrencyIdentity(item) === 'node-exclusive:*')) return false;
  if (!candidateIdentity) return true;
  return !selected.some(item => concurrencyIdentity(item) === candidateIdentity);
}

function selectWave(plan: SchedulerAwareTask[], maxParallel: number): SchedulerAwareTask[] {
  const ready = plan.filter(item => item.availability === 'ready' && item.dispatchable);
  const selected: SchedulerAwareTask[] = [];
  for (const candidate of ready) {
    if (selected.length >= maxParallel) break;
    if (!compatibleWithWave(selected, candidate)) continue;
    selected.push(candidate);
    if (candidate.task.execution?.kind === 'worker-provider') break;
  }
  return selected;
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).trim().slice(0, 1024) || 'wave-task-failed';
}

export class ObjectiveWaveExecutionService {
  constructor(
    private readonly awareness: ObjectiveWaveAwarenessSource,
    private readonly execution: ObjectiveWaveExecutor,
    private readonly taskGraphs: ObjectiveWaveGraphSource
  ) {}

  async executeWave(objectiveId: string, input: ObjectiveWaveExecutionInput = {}): Promise<ObjectiveWaveExecutionResult> {
    const limit = boundedInteger(input.limit, 16, 1, 64, 'limit');
    const maxParallel = boundedInteger(input.maxParallel, 2, 1, 4, 'maxParallel');
    const snapshot = await this.awareness.snapshot(objectiveId, limit);
    const selected = selectWave(snapshot.plan, maxParallel);
    const results = await Promise.all(selected.map(async item => {
      try {
        await this.execution.execute(objectiveId, item.task.id);
      } catch (error) {
        // Durable Task Graph state is authoritative; refresh below rather than trusting the thrown provider/workflow error.
        return { taskId: item.task.id, title: item.task.title, thrown: message(error) };
      }
      return { taskId: item.task.id, title: item.task.title };
    }));

    const objective = await this.taskGraphs.get(objectiveId);
    const byId = new Map(objective.tasks.map(task => [task.id, task]));
    const normalized: ObjectiveWaveTaskResult[] = results.map(result => {
      const task = byId.get(result.taskId);
      return {
        taskId: result.taskId,
        title: result.title,
        status: task?.status ?? 'failed',
        ...((task?.error ?? result.thrown) ? { error: task?.error ?? result.thrown } : {})
      };
    });
    const remainingReady = objective.tasks.filter(task => task.status === 'ready').length;
    return {
      objectiveId,
      selectedTaskIds: selected.map(item => item.task.id),
      serializedWorkerTask: selected.some(item => item.task.execution?.kind === 'worker-provider'),
      results: normalized,
      objectiveStatus: objective.status,
      remainingReady,
      authority: 'bounded-wave-execution',
      note: selected.length === 0
        ? 'No scheduler-ready task was executed in this wave. Inspect work_objective_schedule for provider/resource/session blockers.'
        : 'One bounded scheduler-ready wave was executed. Worker-provider tasks are serialized within a Work Session to protect the shared session worktree; safe deterministic tasks may run in parallel when concurrency identities do not conflict.'
    };
  }
}
