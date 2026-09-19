import type { EngineeringWorkflowExecutionService } from './engineering-workflow-execution.js';
import type { TaskAttemptRecord, TaskAttemptStatus, TaskAttemptStore } from './task-attempt-store.js';
import type { TaskExecutionCoordinator } from './task-executor.js';
import type { TaskGraphStore, WorkTask } from './task-graph.js';

class TaskWorkflowOutcomeError extends Error {
  constructor(
    readonly workflowStatus: 'blocked' | 'failed',
    readonly workflowRunId?: string
  ) {
    super(`TASK_WORKFLOW_NOT_SUCCEEDED: workflow status=${workflowStatus}.`);
  }
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).trim().slice(0, 1024) || 'task-execution-failed';
}

function attemptStatus(error: unknown): Exclude<TaskAttemptStatus, 'running'> {
  if (error instanceof TaskWorkflowOutcomeError && error.workflowStatus === 'blocked') return 'blocked';
  return 'failed';
}

export class TaskWorkflowExecutionService {
  constructor(
    private readonly taskGraphs: TaskGraphStore,
    private readonly taskExecutor: TaskExecutionCoordinator,
    private readonly workflowExecution: EngineeringWorkflowExecutionService,
    private readonly taskAttempts: TaskAttemptStore
  ) {}

  private async task(objectiveId: string, taskId: string): Promise<WorkTask> {
    const objective = await this.taskGraphs.get(objectiveId);
    const task = objective.tasks.find(item => item.id === taskId);
    if (!task) throw new Error(`Unknown Work Task '${taskId}'.`);
    return task;
  }

  async execute(objectiveId: string, taskId: string) {
    const task = await this.task(objectiveId, taskId);
    const existing = await this.taskAttempts.getForGeneration(
      objectiveId,
      taskId,
      task.generation
    );
    if (existing) {
      return {
        task,
        attempt: existing,
        replayed: true,
        output: null
      };
    }

    if (!task.execution || task.execution.kind !== 'engineering-workflow') {
      throw new Error(`TASK_NOT_DISPATCHABLE: Work Task '${taskId}' has no typed engineering-workflow binding.`);
    }

    const binding = task.execution;
    let attempt: TaskAttemptRecord | undefined;
    let workflowRunId: string | undefined;

    try {
      const executed = await this.taskExecutor.execute(
        objectiveId,
        taskId,
        async () => {
          const output = await this.workflowExecution.run(
            binding.workspace,
            binding.projectPath,
            binding.workflow,
            binding.parameters
          );
          const workflowRun = output.workflowRun as { id?: unknown; status?: unknown } | undefined;
          workflowRunId = typeof workflowRun?.id === 'string' ? workflowRun.id : undefined;
          const status = String(workflowRun?.status ?? 'unknown');
          if (status === 'blocked' || status === 'failed') {
            throw new TaskWorkflowOutcomeError(status, workflowRunId);
          }
          if (status !== 'succeeded') {
            throw new Error(`TASK_WORKFLOW_NOT_SUCCEEDED: workflow status=${status}.`);
          }
          return output;
        },
        {
          onStarted: async started => {
            const begun = await this.taskAttempts.begin(
              objectiveId,
              taskId,
              started.generation
            );
            if (!begun.created) {
              throw new Error(
                `TASK_ATTEMPT_ALREADY_EXISTS: generation=${started.generation} attempt=${begun.attempt.id}.`
              );
            }
            attempt = begun.attempt;
          }
        }
      );

      if (!attempt) {
        throw new Error('TASK_ATTEMPT_MISSING: execution started without durable attempt state.');
      }
      const finishedAttempt = await this.taskAttempts.finish(attempt.id, 'succeeded', {
        workflowRunId
      });
      return {
        task: executed.task,
        attempt: finishedAttempt,
        replayed: false,
        output: executed.result
      };
    } catch (error) {
      if (attempt) {
        await this.taskAttempts.finish(attempt.id, attemptStatus(error), {
          error: message(error),
          workflowRunId:
            error instanceof TaskWorkflowOutcomeError
              ? error.workflowRunId ?? workflowRunId
              : workflowRunId
        }).catch(() => undefined);
      }
      throw error;
    }
  }

  async cancel(objectiveId: string, taskId: string) {
    let task = await this.task(objectiveId, taskId);
    const existing = await this.taskAttempts.getForGeneration(
      objectiveId,
      taskId,
      task.generation
    );

    if (task.status === 'pending' || task.status === 'ready') {
      try {
        task = await this.taskGraphs.cancelTask(objectiveId, taskId);
        const attempt = await this.taskAttempts.recordCancelled(
          objectiveId,
          taskId,
          task.generation
        );
        return {
          task,
          attempt,
          cancellationRequested: true,
          preempted: true,
          note: 'Task was cancelled before typed workflow dispatch.'
        };
      } catch (error) {
        if (!message(error).startsWith('TASK_RUNNING:')) throw error;
        task = await this.task(objectiveId, taskId);
      }
    }

    if (task.status === 'running') {
      const attempt = await this.taskAttempts.requestCancellation(
        objectiveId,
        taskId,
        task.generation
      );
      return {
        task,
        attempt: attempt ?? existing ?? null,
        cancellationRequested: attempt !== undefined,
        preempted: false,
        note: attempt
          ? 'Cancellation request recorded. The current generic typed-workflow contract does not claim provider preemption; the real workflow outcome remains authoritative.'
          : 'Task is running but its durable attempt has not been created yet; no provider preemption was claimed.'
      };
    }

    return {
      task,
      attempt: existing ?? null,
      cancellationRequested: false,
      preempted: false,
      note: `Task is already terminal or blocked (status=${task.status}); no execution was changed.`
    };
  }

  async retry(objectiveId: string, taskId: string) {
    const current = await this.task(objectiveId, taskId);
    const previousAttempt = await this.taskAttempts.getForGeneration(
      objectiveId,
      taskId,
      current.generation
    );
    if (previousAttempt?.status === 'running') {
      throw new Error(
        `TASK_ATTEMPT_RUNNING: generation=${current.generation} attempt=${previousAttempt.id}.`
      );
    }
    const task = await this.taskGraphs.retryTask(objectiveId, taskId);
    return {
      task,
      previousAttempt: previousAttempt ?? null,
      note: `Retry created generation ${task.generation}; previous generation will never execute again.`
    };
  }
}
