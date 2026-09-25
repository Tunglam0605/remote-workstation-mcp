import type { ConcurrencyOperation } from './concurrency-policy.js';
import type { ExecutionPolicyService } from './execution-policy.js';
import type { PersistedWorkflowParameters } from './engineering-workflow-contract.js';
import type { SetupSettings, ExecutionTargetId } from './setup/settings.js';
import { loadSetupSettings } from './setup/settings.js';
import {
  affinityOrderForIntent,
  allowedExecutionTargets,
  planWorkerRoute,
  type WorkerRoutePlan,
  type WorkerRoutingIntent
} from './worker-route-plan.js';
import type { TaskGraphStore, WorkTask, WorkTaskExecutionBinding } from './task-graph.js';
import type { WorkerProviderRegistry, WorkerProviderStatus } from './worker-provider.js';
import type { WorkSession } from './work-session.js';

export type DecompositionExecutionInput =
  | { kind: 'auto-worker' }
  | { kind: 'worker-provider'; providerId: string }
  | {
      kind: 'engineering-workflow';
      workspace: string;
      projectPath: string;
      workflow: string;
      parameters: PersistedWorkflowParameters;
    };

export interface ObjectiveDecompositionTaskInput {
  key: string;
  title: string;
  description?: string;
  intent: WorkerRoutingIntent;
  priority?: number;
  dependsOn?: string[];
  concurrencyOperation?: ConcurrencyOperation;
  concurrencyKey?: string;
  execution: DecompositionExecutionInput;
}

export interface ObjectiveDecompositionInput {
  tasks: ObjectiveDecompositionTaskInput[];
  requireEmpty?: boolean;
}

export interface ObjectiveDecompositionAssignment {
  key: string;
  taskId: string;
  intent: WorkerRoutingIntent;
  execution: WorkTaskExecutionBinding;
  routePlan?: WorkerRoutePlan;
}

export interface ObjectiveDecompositionResult {
  objectiveId: string;
  atomic: true;
  tasks: WorkTask[];
  keyMap: Record<string, string>;
  assignments: ObjectiveDecompositionAssignment[];
  note: string;
}

export interface ObjectiveDecompositionSessionSource {
  list(includeClosed?: boolean): Promise<WorkSession[]>;
}

export interface ObjectiveDecompositionOptions {
  loadSettings?: () => Promise<SetupSettings>;
}

function defaultConcurrency(intent: WorkerRoutingIntent): ConcurrencyOperation {
  if (intent === 'coding' || intent === 'frontend-ui' || intent === 'debug') return 'source.edit';
  return 'project.inspect';
}

function validateLocalGraph(tasks: ObjectiveDecompositionTaskInput[]): void {
  if (tasks.length < 1 || tasks.length > 64) throw new Error('Decomposition requires between 1 and 64 tasks.');
  const keys = tasks.map(item => item.key.trim());
  for (const key of keys) {
    if (!/^[a-z][a-z0-9._-]{0,63}$/.test(key)) {
      throw new Error(`Invalid decomposition task key '${key}'.`);
    }
  }
  if (new Set(keys).size !== keys.length) throw new Error('Decomposition task keys must be unique.');
  const byKey = new Map(tasks.map(item => [item.key.trim(), item]));
  for (const task of tasks) {
    const key = task.key.trim();
    const dependencies = task.dependsOn ?? [];
    if (dependencies.length > 64) throw new Error(`Task '${key}' has too many dependencies.`);
    if (new Set(dependencies).size !== dependencies.length) throw new Error(`Task '${key}' has duplicate dependencies.`);
    for (const dependency of dependencies) {
      if (!byKey.has(dependency)) throw new Error(`Task '${key}' depends on unknown task key '${dependency}'.`);
      if (dependency === key) throw new Error(`Task '${key}' cannot depend on itself.`);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string): void => {
    if (visited.has(key)) return;
    if (visiting.has(key)) throw new Error(`DECOMPOSITION_CYCLE: dependency cycle detected at '${key}'.`);
    visiting.add(key);
    for (const dependency of byKey.get(key)?.dependsOn ?? []) visit(dependency);
    visiting.delete(key);
    visited.add(key);
  };
  for (const key of keys) visit(key);
}

function providerReady(statuses: WorkerProviderStatus[], providerId: string): boolean {
  const status = statuses.find(item => item.provider.id === providerId);
  return Boolean(status && status.dispatchCapable && status.availability === 'available');
}

function autoWorkerTarget(
  intent: WorkerRoutingIntent,
  settings: SetupSettings,
  policy: Awaited<ReturnType<ExecutionPolicyService['status']>>,
  providers: WorkerProviderStatus[]
): { target: 'codex-local' | 'antigravity-local'; routePlan: WorkerRoutePlan } {
  const routePlan = planWorkerRoute({ settings: settings.execution, status: policy, providers, intent });
  const allowed = new Set(allowedExecutionTargets(settings.execution, policy));
  const workerOrder = affinityOrderForIntent(intent).filter(
    (target): target is 'codex-local' | 'antigravity-local' =>
      target === 'codex-local' || target === 'antigravity-local'
  );
  const target = workerOrder.find(candidate => allowed.has(candidate) && providerReady(providers, candidate))
    ?? workerOrder.find(candidate => allowed.has(candidate));
  if (!target) {
    throw new Error(`NO_AI_TARGET_ALLOWED: task intent '${intent}' has no Codex/Antigravity target allowed by the effective Work Session policy.`);
  }
  return { target, routePlan };
}

export class ObjectiveDecompositionService {
  private readonly loadSettings: () => Promise<SetupSettings>;

  constructor(
    private readonly taskGraphs: TaskGraphStore,
    private readonly executionPolicy: ExecutionPolicyService,
    private readonly workerProviders: WorkerProviderRegistry,
    private readonly workSessions: ObjectiveDecompositionSessionSource,
    options: ObjectiveDecompositionOptions = {}
  ) {
    this.loadSettings = options.loadSettings ?? loadSetupSettings;
  }

  async decompose(objectiveId: string, input: ObjectiveDecompositionInput): Promise<ObjectiveDecompositionResult> {
    validateLocalGraph(input.tasks);
    const objective = await this.taskGraphs.get(objectiveId);
    const sessions = await this.workSessions.list(false);
    const session = sessions.find(item => item.id === objective.workSessionId);
    if (!session) throw new Error(`WORK_SESSION_UNAVAILABLE: '${objective.workSessionId}' is not active.`);

    const [settings, policy, providers] = await Promise.all([
      this.loadSettings(),
      this.executionPolicy.status(objective.workSessionId),
      this.workerProviders.listStatus()
    ]);
    const allowedTargets = new Set(allowedExecutionTargets(settings.execution, policy));
    const prepared: Array<{
      source: ObjectiveDecompositionTaskInput;
      execution: WorkTaskExecutionBinding;
      routePlan?: WorkerRoutePlan;
      concurrencyOperation: ConcurrencyOperation;
      concurrencyKey?: string;
    }> = [];

    for (const source of input.tasks) {
      let execution: WorkTaskExecutionBinding;
      let routePlan: WorkerRoutePlan | undefined;
      if (source.execution.kind === 'auto-worker') {
        const routed = autoWorkerTarget(source.intent, settings, policy, providers);
        execution = { kind: 'worker-provider', providerId: routed.target };
        routePlan = routed.routePlan;
      } else if (source.execution.kind === 'worker-provider') {
        const providerId = source.execution.providerId.trim();
        const descriptor = this.workerProviders.descriptor(providerId);
        if (!descriptor) throw new Error(`WORKER_PROVIDER_UNREGISTERED: '${providerId}'.`);
        if ((providerId === 'codex-local' || providerId === 'antigravity-local') && !allowedTargets.has(providerId as ExecutionTargetId)) {
          throw new Error(`WORKER_PROVIDER_NOT_ALLOWED: '${providerId}' is excluded by the effective target policy.`);
        }
        execution = { kind: 'worker-provider', providerId };
      } else {
        execution = {
          kind: 'engineering-workflow',
          workspace: source.execution.workspace,
          projectPath: source.execution.projectPath,
          workflow: source.execution.workflow,
          parameters: source.execution.parameters
        };
      }

      const concurrencyOperation = source.concurrencyOperation ?? defaultConcurrency(source.intent);
      let concurrencyKey = source.concurrencyKey?.trim() || undefined;
      if (concurrencyOperation === 'source.edit' && !concurrencyKey) {
        concurrencyKey = session.capsule.project?.worktreePath;
        if (!concurrencyKey) {
          throw new Error(`WORKER_WORKTREE_REQUIRED: task '${source.key}' needs source.edit but the Work Session has no isolated worktree.`);
        }
      }
      prepared.push({ source, execution, routePlan, concurrencyOperation, ...(concurrencyKey ? { concurrencyKey } : {}) });
    }

    const persisted = await this.taskGraphs.addTaskBatch(objectiveId, {
      requireEmpty: input.requireEmpty ?? true,
      tasks: prepared.map(item => ({
        key: item.source.key,
        dependsOn: item.source.dependsOn,
        task: {
          title: item.source.title,
          description: item.source.description,
          priority: item.source.priority,
          concurrency: {
            operation: item.concurrencyOperation,
            ...(item.concurrencyKey ? { key: item.concurrencyKey } : {})
          },
          planning: {
            source: 'decomposition',
            key: item.source.key,
            intent: item.source.intent,
            preferredTarget: item.execution.kind === 'worker-provider' ? item.execution.providerId : 'rwmcp-direct'
          },
          execution: item.execution
        }
      }))
    });

    return {
      objectiveId,
      atomic: true,
      tasks: persisted.tasks,
      keyMap: persisted.keyMap,
      assignments: prepared.map(item => ({
        key: item.source.key,
        taskId: persisted.keyMap[item.source.key],
        intent: item.source.intent,
        execution: item.execution,
        ...(item.routePlan ? { routePlan: item.routePlan } : {})
      })),
      note: 'ChatGPT supplied the decomposition plan; RWMCP validated and persisted it atomically. Auto-worker assignment is deterministic from owner/session target policy plus task affinity. No planner model runs inside RWMCP.'
    };
  }
}
