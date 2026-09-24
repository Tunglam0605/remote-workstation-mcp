import type { EngineeringWorkflowExecutionService } from './engineering-workflow-execution.js';
import type { TaskAttemptRecord, TaskAttemptStatus, TaskAttemptStore, TaskProviderAttemptRecord } from './task-attempt-store.js';
import type { TaskExecutionCoordinator } from './task-executor.js';
import type { TaskGraphStore, WorkTask } from './task-graph.js';
import type { WorkerProviderRegistry, WorkerDispatchResult } from './worker-provider.js';
import type { WorkSessionStore } from './work-session.js';
import type { WorktreeManager, WorktreeState } from './worktree-manager.js';
import { isWorkerCapacitySignal, type ExecutionPolicyService } from './execution-policy.js';
import type { DesktopNotificationService } from './desktop-notification.js';

class TaskWorkflowOutcomeError extends Error {
  constructor(
    readonly workflowStatus: 'blocked' | 'failed',
    readonly workflowRunId?: string
  ) {
    super(`TASK_WORKFLOW_NOT_SUCCEEDED: workflow status=${workflowStatus}.`);
  }
}

class WorkerProviderOutcomeError extends Error {
  constructor(
    readonly providerStatus: 'blocked' | 'failed',
    readonly providerId: string,
    readonly providerRunId?: string,
    readonly providerSummary?: string
  ) {
    super(
      `TASK_WORKER_NOT_SUCCEEDED: provider=${providerId} status=${providerStatus}` +
      (providerSummary ? ` summary=${providerSummary}` : '') +
      '.'
    );
  }
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).trim().slice(0, 1024) || 'task-execution-failed';
}

function attemptStatus(error: unknown): Exclude<TaskAttemptStatus, 'running'> {
  if (error instanceof TaskWorkflowOutcomeError && error.workflowStatus === 'blocked') return 'blocked';
  if (error instanceof WorkerProviderOutcomeError && error.providerStatus === 'blocked') return 'blocked';
  return 'failed';
}

type AiWorkerProviderId = 'codex-local' | 'antigravity-local';

function aiWorkerProvider(value: string): value is AiWorkerProviderId {
  return value === 'codex-local' || value === 'antigravity-local';
}

function alternateAiWorker(value: AiWorkerProviderId): AiWorkerProviderId {
  return value === 'codex-local' ? 'antigravity-local' : 'codex-local';
}

function compactProviderTrace(attempts: TaskProviderAttemptRecord[]): string {
  return attempts
    .map(item => `${item.providerId}=${item.status}${item.summary ? `:${item.summary}` : ''}`)
    .join(' -> ')
    .slice(0, 1024);
}

export class TaskWorkflowExecutionService {
  constructor(
    private readonly taskGraphs: TaskGraphStore,
    private readonly taskExecutor: TaskExecutionCoordinator,
    private readonly workflowExecution: EngineeringWorkflowExecutionService,
    private readonly taskAttempts: TaskAttemptStore,
    private readonly workerProviders?: WorkerProviderRegistry,
    private readonly workSessions?: WorkSessionStore,
    private readonly worktreeManager?: Pick<WorktreeManager, 'status'>,
    private readonly executionPolicy?: ExecutionPolicyService,
    private readonly desktopNotifications?: Pick<DesktopNotificationService, 'notify'>
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

    if (!task.execution) {
      throw new Error(`TASK_NOT_DISPATCHABLE: Work Task '${taskId}' has no persisted execution binding.`);
    }
    if (task.execution.kind === 'engineering-workflow') {
      return await this.executeWorkflow(objectiveId, task);
    }
    if (task.execution.kind === 'worker-provider') {
      return await this.executeWorker(objectiveId, task);
    }
    throw new Error(`TASK_NOT_DISPATCHABLE: Work Task '${taskId}' has an unsupported execution binding.`);
  }

  private async executeWorkflow(objectiveId: string, task: WorkTask) {
    if (!task.execution || task.execution.kind !== 'engineering-workflow') {
      throw new Error(`TASK_NOT_DISPATCHABLE: Work Task '${task.id}' has no typed engineering-workflow binding.`);
    }
    const binding = task.execution;
    let attempt: TaskAttemptRecord | undefined;
    let workflowRunId: string | undefined;

    try {
      const executed = await this.taskExecutor.execute(
        objectiveId,
        task.id,
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
            const begun = await this.taskAttempts.begin(objectiveId, task.id, started.generation);
            if (!begun.created) {
              throw new Error(
                `TASK_ATTEMPT_ALREADY_EXISTS: generation=${started.generation} attempt=${begun.attempt.id}.`
              );
            }
            attempt = begun.attempt;
          }
        }
      );

      if (!attempt) throw new Error('TASK_ATTEMPT_MISSING: execution started without durable attempt state.');
      const finishedAttempt = await this.taskAttempts.finish(attempt.id, 'succeeded', { workflowRunId });
      return { task: executed.task, attempt: finishedAttempt, replayed: false, output: executed.result };
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

  private async workerProviderChain(
    preferredProviderId: string,
    workSessionId: string
  ): Promise<string[]> {
    if (!aiWorkerProvider(preferredProviderId) || !this.executionPolicy || !this.workerProviders) {
      return [preferredProviderId];
    }
    const [settings, status] = await Promise.all([
      this.executionPolicy.settings(),
      this.executionPolicy.status(workSessionId)
    ]);
    if (status.effectiveMode !== 'both' || status.fallbackActive) return [preferredProviderId];

    const alternate = alternateAiWorker(preferredProviderId);
    const alternateEnabled = alternate === 'codex-local'
      ? settings.execution.codexEnabled
      : settings.execution.antigravityEnabled;
    if (!alternateEnabled || !this.workerProviders.descriptor(alternate)) return [preferredProviderId];
    return [preferredProviderId, alternate];
  }

  private async executeWorker(objectiveId: string, task: WorkTask) {
    if (!task.execution || task.execution.kind !== 'worker-provider') {
      throw new Error(`TASK_NOT_DISPATCHABLE: Work Task '${task.id}' has no worker-provider binding.`);
    }
    if (!this.workerProviders || !this.workSessions) {
      throw new Error('WORKER_PROVIDER_EXECUTION_UNAVAILABLE: runtime did not configure worker orchestration services.');
    }

    const binding = task.execution;
    const objective = await this.taskGraphs.get(objectiveId);
    const session = await this.workSessions.inspect(objective.workSessionId, true);
    const project = session.capsule.project;
    const providerDescriptor = this.workerProviders.descriptor(binding.providerId);
    let liveWorktree: WorktreeState | undefined;
    if (providerDescriptor?.worktreeAssignment && this.worktreeManager) {
      try {
        liveWorktree = await this.worktreeManager.status(objective.workSessionId);
      } catch {
        throw new Error('TASK_WAITING_SESSION: WORKER_WORKTREE_UNAVAILABLE.');
      }
      if (!liveWorktree.worktreePath) {
        throw new Error('TASK_WAITING_SESSION: WORKER_WORKTREE_REQUIRED.');
      }
    }
    const dispatchProject = project?.workspace && project.projectPath
      ? {
          workspace: project.workspace,
          projectPath: project.projectPath,
          ...(liveWorktree?.worktreePath
            ? {
                worktreePath: liveWorktree.worktreePath,
                ...(liveWorktree.buildDir ? { buildDir: liveWorktree.buildDir } : {}),
                ...(liveWorktree.branch ? { branch: liveWorktree.branch } : {}),
                ...(liveWorktree.commit ? { commit: liveWorktree.commit } : {})
              }
            : {
                ...(project.worktreePath ? { worktreePath: project.worktreePath } : {}),
                ...(project.buildDir ? { buildDir: project.buildDir } : {}),
                ...(project.branch ? { branch: project.branch } : {}),
                ...(project.commit ? { commit: project.commit } : {})
              })
        }
      : undefined;
    let attempt: TaskAttemptRecord | undefined;
    let providerResult: WorkerDispatchResult | undefined;
    let selectedProviderId = binding.providerId;
    const providerAttempts: TaskProviderAttemptRecord[] = [];

    try {
      const executed = await this.taskExecutor.execute(
        objectiveId,
        task.id,
        async () => {
          const providerChain = await this.workerProviderChain(binding.providerId, objective.workSessionId);
          const dispatchRequest = {
            version: 1 as const,
            workSessionId: objective.workSessionId,
            objective: {
              id: objective.id,
              name: objective.name,
              objective: objective.objective
            },
            task: {
              id: task.id,
              generation: task.generation,
              title: task.title,
              ...(task.description ? { description: task.description } : {})
            },
            ...(dispatchProject ? { project: dispatchProject } : {})
          };

          for (const providerId of providerChain) {
            selectedProviderId = providerId;
            if (providerId === 'codex-local' && this.executionPolicy) {
              try {
                await this.executionPolicy.beforeCodexDispatch(objective.workSessionId, { deferFallback: true });
              } catch (error) {
                const summary = message(error);
                if (!isWorkerCapacitySignal(summary)) throw error;
                providerAttempts.push({ providerId, status: 'blocked', summary });
                continue;
              }
            }

            try {
              providerResult = await this.workerProviders!.dispatch(providerId, dispatchRequest);
            } catch (error) {
              const summary = message(error);
              if (!isWorkerCapacitySignal(summary)) {
                providerAttempts.push({ providerId, status: 'failed', summary });
                throw error;
              }
              providerAttempts.push({ providerId, status: 'blocked', summary });
              continue;
            }

            if (providerResult.status === 'succeeded') {
              providerAttempts.push({
                providerId,
                status: 'succeeded',
                ...(providerResult.runId ? { providerRunId: providerResult.runId } : {}),
                ...(providerResult.summary ? { summary: providerResult.summary } : {})
              });
              return providerResult;
            }

            if (isWorkerCapacitySignal(providerResult.summary)) {
              providerAttempts.push({
                providerId,
                status: providerResult.status,
                ...(providerResult.runId ? { providerRunId: providerResult.runId } : {}),
                ...(providerResult.summary ? { summary: providerResult.summary } : {})
              });
              continue;
            }

            providerAttempts.push({
              providerId,
              status: providerResult.status,
              ...(providerResult.runId ? { providerRunId: providerResult.runId } : {}),
              ...(providerResult.summary ? { summary: providerResult.summary } : {})
            });
            throw new WorkerProviderOutcomeError(
              providerResult.status,
              providerId,
              providerResult.runId,
              providerResult.summary
            );
          }

          const trace = compactProviderTrace(providerAttempts) || 'no AI worker route remained usable';
          if (this.executionPolicy) {
            const settings = await this.executionPolicy.settings();
            if (settings.execution.codexFallback === 'rwmcp-only') {
              await this.executionPolicy.activateSessionFallback(
                objective.workSessionId,
                'workers-exhausted',
                trace
              );
              throw new WorkerProviderOutcomeError(
                'blocked',
                selectedProviderId,
                providerResult?.runId,
                `WORKER_FALLBACK_ACTIVE: all allowed AI workers exhausted capacity or availability; effective Work Session route switched to RWMCP direct. ${trace}`
              );
            }
          }
          throw new WorkerProviderOutcomeError(
            'blocked',
            selectedProviderId,
            providerResult?.runId,
            `WORKER_CAPACITY_EXHAUSTED: all allowed AI workers exhausted capacity or availability; owner fallback policy is stop. ${trace}`
          );
        },
        {
          onStarted: async started => {
            const begun = await this.taskAttempts.begin(
              objectiveId,
              task.id,
              started.generation,
              { providerId: binding.providerId }
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

      if (!attempt) throw new Error('TASK_ATTEMPT_MISSING: worker execution started without durable attempt state.');
      const finishedAttempt = await this.taskAttempts.finish(attempt.id, 'succeeded', {
        providerId: selectedProviderId,
        providerRunId: providerResult?.runId,
        providerAttempts
      });
      if (aiWorkerProvider(selectedProviderId) && this.desktopNotifications) {
        const workerName = selectedProviderId === 'codex-local' ? 'Codex' : 'Antigravity';
        await this.desktopNotifications.notify({
          title: `${workerName} task hoàn tất`,
          body: `${task.title} — ${session.name}`,
          kind: 'success'
        }).catch(() => undefined);
      }
      return { task: executed.task, attempt: finishedAttempt, replayed: false, output: executed.result };
    } catch (error) {
      if (attempt) {
        await this.taskAttempts.finish(attempt.id, attemptStatus(error), {
          error: message(error),
          providerId: selectedProviderId,
          providerRunId:
            error instanceof WorkerProviderOutcomeError
              ? error.providerRunId ?? providerResult?.runId
              : providerResult?.runId,
          providerAttempts
        }).catch(() => undefined);
      }
      if (aiWorkerProvider(binding.providerId) && this.desktopNotifications) {
        const errorText = message(error);
        const fallback = errorText.includes('WORKER_FALLBACK_ACTIVE') || errorText.includes('CODEX_FALLBACK_ACTIVE');
        const blocked = attemptStatus(error) === 'blocked';
        const workerName = binding.providerId === 'codex-local' ? 'Codex' : 'Antigravity';
        await this.desktopNotifications.notify({
          title: fallback ? 'AI workers đã chuyển sang RWMCP' : blocked ? `${workerName} task bị chặn` : `${workerName} task thất bại`,
          body: `${task.title}: ${errorText}`,
          kind: blocked || fallback ? 'warning' : 'error'
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
          note: 'Task was cancelled before persisted execution binding dispatch.'
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
          ? 'Cancellation request recorded. The generic task-execution contract does not claim provider preemption; the real execution outcome remains authoritative.'
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
