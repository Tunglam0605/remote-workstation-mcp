import type { EngineeringResourceManager } from './adapters/engineering/resource-manager.js';
import type { NodeInterlockStore } from './node-interlock.js';
import {
  DeterministicTaskScheduler,
  TaskGraphStore,
  type ScheduledTask,
  type WorkTask
} from './task-graph.js';

export interface TaskExecutionResult<T> {
  task: WorkTask;
  result: T;
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).trim().slice(0, 1024) || 'task-execution-failed';
}

function leaseResourceId(item: ScheduledTask): string | undefined {
  const decision = item.concurrencyDecision;
  if (!decision || decision.class === 'shared' || decision.class === 'owner-local-only') return undefined;
  if (decision.class === 'node-exclusive') return 'orchestration:node-exclusive';
  const key = item.task.concurrency.key?.trim();
  if (!key) return undefined;
  return `orchestration:${decision.class}:${key}`;
}

export class TaskExecutionCoordinator {
  constructor(
    private readonly store: TaskGraphStore,
    private readonly scheduler: DeterministicTaskScheduler,
    private readonly resources: EngineeringResourceManager,
    private readonly nodeInterlocks: NodeInterlockStore
  ) {}

  async execute<T>(
    objectiveId: string,
    taskId: string,
    operation: () => Promise<T>
  ): Promise<TaskExecutionResult<T>> {
    const plan = await this.scheduler.plan(objectiveId, 128);
    const item = plan.find(candidate => candidate.task.id === taskId);
    if (!item) {
      const objective = await this.store.get(objectiveId);
      const task = objective.tasks.find(candidate => candidate.id === taskId);
      if (!task) throw new Error(`Unknown Work Task '${taskId}'.`);
      throw new Error(`TASK_NOT_READY: Work Task '${taskId}' is ${task.status}.`);
    }
    if (!item.dispatchable) {
      throw new Error(`TASK_NOT_DISPATCHABLE: ${item.blocker ?? 'scheduler-blocked'}.`);
    }

    const run = async (): Promise<TaskExecutionResult<T>> => {
      let interlockId: string | undefined;
      if (item.concurrencyDecision?.class === 'node-exclusive') {
        const interlock = await this.nodeInterlocks.acquireWorkflow(
          `task:${objectiveId}:${taskId}`
        );
        interlockId = interlock.id;
      }

      try {
        await this.store.startTask(objectiveId, taskId);
        try {
          const result = await operation();
          const task = await this.store.finishTask(objectiveId, taskId, 'succeeded');
          return { task, result };
        } catch (error) {
          try {
            await this.store.finishTask(objectiveId, taskId, 'failed', errorMessage(error));
          } catch {
            // If persistence itself fails, restart reconciliation remains the recovery boundary.
          }
          throw error;
        }
      } finally {
        if (interlockId) {
          await this.nodeInterlocks.release(interlockId);
        }
      }
    };

    const resourceId = leaseResourceId(item);
    if (!resourceId) return await run();
    return await this.resources.withLease(resourceId, 'orchestrating', run);
  }
}

