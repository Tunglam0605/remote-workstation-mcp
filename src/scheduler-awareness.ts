import type { EngineeringResourceLease, SerialSessionSnapshot, DebugSessionSnapshot } from './engineering/types.js';
import type { EngineeringResourceManager } from './adapters/engineering/resource-manager.js';
import type { NodeInterlockRecord, NodeInterlockStore } from './node-interlock.js';
import type { TaskAttemptRecord, TaskAttemptStore } from './task-attempt-store.js';
import type { DeterministicTaskScheduler, ScheduledTask, TaskGraphStore } from './task-graph.js';
import type { WorkSession, WorkSessionStore } from './work-session.js';
import type { WorkerProviderStatus } from './worker-provider.js';

export type SchedulerAvailability =
  | 'ready'
  | 'waiting-resource'
  | 'waiting-session'
  | 'waiting-node'
  | 'waiting-provider'
  | 'blocked';

export interface SchedulerAwareTask extends ScheduledTask {
  availability: SchedulerAvailability;
  waitReason?: string;
  blockingResources?: EngineeringResourceLease[];
  blockingSessionIds?: string[];
  blockingNodeInterlocks?: NodeInterlockRecord[];
}

export interface SchedulerSessionAwareness {
  id: string;
  name?: string;
  updatedAt: string;
  worktreePath?: string;
  buildDir?: string;
  branch?: string;
  commit?: string;
}

export interface SchedulerAwarenessSnapshot {
  plan: SchedulerAwareTask[];
  sessions: SchedulerSessionAwareness[];
  recentAttempts: TaskAttemptRecord[];
  resources: EngineeringResourceLease[];
  serialSessions: SerialSessionSnapshot[];
  debugSessions: DebugSessionSnapshot[];
  nodeInterlocks: NodeInterlockRecord[];
  workerProviders: WorkerProviderStatus[];
}

export interface SchedulerSessionProvider {
  list(includeClosed?: boolean): Promise<WorkSession[]>;
}

export interface SchedulerSessionListProvider<T> {
  list(): T[];
}

export interface SchedulerWorkerProviderStatusSource {
  listStatus(): Promise<WorkerProviderStatus[]>;
}

function orchestrationResourceId(item: ScheduledTask): string | undefined {
  const decision = item.concurrencyDecision;
  if (!decision || decision.class === 'shared' || decision.class === 'owner-local-only') return undefined;
  if (decision.class === 'node-exclusive') return 'orchestration:node-exclusive';
  const key = item.task.concurrency.key?.trim();
  if (!key) return undefined;
  return `orchestration:${decision.class}:${key}`;
}

function sessionSummary(session: WorkSession): SchedulerSessionAwareness {
  return {
    id: session.id,
    ...(session.name ? { name: session.name } : {}),
    updatedAt: session.updatedAt,
    ...(session.capsule.project?.worktreePath ? { worktreePath: session.capsule.project.worktreePath } : {}),
    ...(session.capsule.project?.buildDir ? { buildDir: session.capsule.project.buildDir } : {}),
    ...(session.capsule.project?.branch ? { branch: session.capsule.project.branch } : {}),
    ...(session.capsule.project?.commit ? { commit: session.capsule.project.commit } : {})
  };
}

export class SchedulerAwarenessService {
  constructor(
    private readonly scheduler: DeterministicTaskScheduler,
    private readonly taskGraphs: TaskGraphStore,
    private readonly workSessions: SchedulerSessionProvider,
    private readonly taskAttempts: TaskAttemptStore,
    private readonly resources: EngineeringResourceManager,
    private readonly nodeInterlocks: NodeInterlockStore,
    private readonly serial: SchedulerSessionListProvider<SerialSessionSnapshot>,
    private readonly debug: SchedulerSessionListProvider<DebugSessionSnapshot>,
    private readonly workerProviders?: SchedulerWorkerProviderStatusSource
  ) {}

  private blockingSessions(
    item: ScheduledTask,
    sessions: WorkSession[],
    currentWorkSessionId: string
  ): string[] {
    const decision = item.concurrencyDecision;
    const key = item.task.concurrency.key?.trim();
    if (!decision || decision.class !== 'session-isolated' || !key) return [];
    return sessions
      .filter(session =>
        session.id !== currentWorkSessionId &&
        (session.capsule.project?.worktreePath === key || session.capsule.project?.buildDir === key)
      )
      .map(session => session.id)
      .slice(0, 16);
  }

  private blockingResources(
    item: ScheduledTask,
    resources: EngineeringResourceLease[]
  ): EngineeringResourceLease[] {
    const decision = item.concurrencyDecision;
    if (!decision || decision.class === 'shared' || decision.class === 'owner-local-only') return [];
    const ids = new Set<string>();
    const orchestrationId = orchestrationResourceId(item);
    if (orchestrationId) ids.add(orchestrationId);
    const key = item.task.concurrency.key?.trim();
    if (key && (decision.class === 'resource-exclusive' || decision.class === 'project-variant-exclusive')) {
      // Resource/project keys are expected to use the canonical EngineeringResourceLease.resourceId.
      // Exact matching is intentional: awareness must not invent aliases that could hide a real conflict.
      ids.add(key);
    }
    return resources.filter(lease => ids.has(lease.resourceId)).slice(0, 16);
  }

  async snapshot(objectiveId: string, limit = 32): Promise<SchedulerAwarenessSnapshot> {
    const [objective, plan, sessions, attempts, interlocks, workerProviders] = await Promise.all([
      this.taskGraphs.get(objectiveId),
      this.scheduler.plan(objectiveId, limit),
      this.workSessions.list(false),
      this.taskAttempts.list({ objectiveId, limit: 100 }),
      this.nodeInterlocks.listActive(),
      this.workerProviders ? this.workerProviders.listStatus() : Promise.resolve([])
    ]);
    const resourceLeases = this.resources.list();
    const serialSessions = this.serial.list().slice(0, 64);
    const debugSessions = this.debug.list().slice(0, 64);
    const currentSession = sessions.find(session => session.id === objective.workSessionId);
    const workerStatusById = new Map(workerProviders.map(item => [item.provider.id, item]));

    const awarePlan = plan.map((item): SchedulerAwareTask => {
      if (!item.dispatchable) {
        return {
          ...item,
          availability: 'blocked',
          waitReason: item.blocker ?? 'scheduler-blocked'
        };
      }

      if (item.task.execution?.kind === 'worker-provider') {
        const providerStatus = workerStatusById.get(item.task.execution.providerId);
        if (!providerStatus) {
          return {
            ...item,
            availability: 'waiting-provider',
            waitReason: 'WORKER_PROVIDER_UNREGISTERED'
          };
        }
        if (!providerStatus.dispatchCapable) {
          return {
            ...item,
            availability: 'blocked',
            waitReason: 'WORKER_PROVIDER_NOT_DISPATCH_CAPABLE'
          };
        }
        if (providerStatus.availability !== 'available') {
          return {
            ...item,
            availability: 'waiting-provider',
            waitReason: 'WORKER_PROVIDER_' + providerStatus.availability.toUpperCase()
          };
        }
        if (providerStatus.provider.worktreeAssignment && !currentSession?.capsule.project?.worktreePath) {
          return {
            ...item,
            availability: 'waiting-session',
            waitReason: 'WORKER_WORKTREE_REQUIRED',
            blockingSessionIds: [objective.workSessionId]
          };
        }
      }

      if (item.concurrencyDecision?.class === 'node-exclusive' && interlocks.length > 0) {
        return {
          ...item,
          availability: 'waiting-node',
          waitReason: 'NODE_INTERLOCK_ACTIVE',
          blockingNodeInterlocks: interlocks.slice(0, 16)
        };
      }

      const sessionsBlocking = this.blockingSessions(item, sessions, objective.workSessionId);
      if (sessionsBlocking.length > 0) {
        return {
          ...item,
          availability: 'waiting-session',
          waitReason: 'SESSION_ISOLATED_LOCATION_OWNED',
          blockingSessionIds: sessionsBlocking
        };
      }

      const resourceBlocking = this.blockingResources(item, resourceLeases);
      if (resourceBlocking.length > 0) {
        return {
          ...item,
          availability: 'waiting-resource',
          waitReason: 'RESOURCE_BUSY',
          blockingResources: resourceBlocking
        };
      }

      return {
        ...item,
        availability: 'ready'
      };
    });

    return {
      plan: awarePlan,
      sessions: sessions.slice(0, 64).map(sessionSummary),
      recentAttempts: attempts,
      resources: resourceLeases.slice(0, 128),
      serialSessions,
      debugSessions,
      nodeInterlocks: interlocks.slice(0, 64),
      workerProviders: workerProviders.slice(0, 64)
    };
  }

  async assertDispatchable(objectiveId: string, taskId: string): Promise<SchedulerAwareTask> {
    const snapshot = await this.snapshot(objectiveId, 128);
    const item = snapshot.plan.find(candidate => candidate.task.id === taskId);
    if (!item) {
      throw new Error(`TASK_NOT_READY: Work Task '${taskId}' is not READY in the deterministic scheduler.`);
    }
    if (item.availability !== 'ready') {
      throw new Error(
        `TASK_${item.availability.replaceAll('-', '_').toUpperCase()}: ${item.waitReason ?? 'scheduler-awareness-blocked'}.`
      );
    }
    return item;
  }
}
