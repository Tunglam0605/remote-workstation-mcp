import type { SchedulerAwareTask, SchedulerAwarenessService } from './scheduler-awareness.js';
import type { TaskAttemptRecord, TaskAttemptStore } from './task-attempt-store.js';
import type { TaskGraphStore, WorkObjective, WorkTask, WorkTaskStatus } from './task-graph.js';
import type { WorkSessionStore } from './work-session.js';

export interface ObjectiveProgressCounts {
  total: number;
  succeeded: number;
  failed: number;
  blocked: number;
  cancelled: number;
  running: number;
  ready: number;
  pending: number;
  succeededRatio: number;
}

export interface ObjectiveTaskSummary {
  id: string;
  title: string;
  status: WorkTaskStatus;
  generation: number;
  workflow?: string;
  providerId?: string;
  availability?: SchedulerAwareTask['availability'];
  waitReason?: string;
  latestAttempt?: {
    id: string;
    generation: number;
    status: TaskAttemptRecord['status'];
    updatedAt: string;
    error?: string;
  };
}

export interface ObjectiveBlocker {
  taskId: string;
  title: string;
  kind:
    | 'task-failed'
    | 'task-blocked'
    | 'task-cancelled'
    | 'waiting-resource'
    | 'waiting-session'
    | 'waiting-node'
    | 'waiting-provider';
  reason: string;
  resourceIds?: string[];
  sessionIds?: string[];
}

export interface ObjectiveProgressSummary {
  objective: {
    id: string;
    name: string;
    status: WorkObjective['status'];
    workSessionId: string;
    updatedAt: string;
  };
  progress: ObjectiveProgressCounts;
  tasks: ObjectiveTaskSummary[];
  omittedTaskCount: number;
  activeTasks: ObjectiveTaskSummary[];
  blockers: ObjectiveBlocker[];
  latestFailure: null | {
    attemptId: string;
    taskId: string;
    taskTitle: string;
    generation: number;
    status: TaskAttemptRecord['status'];
    updatedAt: string;
    error?: string;
  };
  nextActionable: Array<{
    taskId: string;
    title: string;
    priority: number;
    workflow?: string;
    providerId?: string;
  }>;
  workSession: null | {
    id: string;
    name?: string;
    updatedAt: string;
    worktreePath?: string;
    buildDir?: string;
    branch?: string;
    commit?: string;
  };
  resources: Array<{
    resourceId: string;
    mode: string;
    ownerId: string;
  }>;
  nodeInterlocks: Array<{
    id: string;
    kind: string;
    workSessionId: string;
    label: string;
  }>;
  generatedAt: string;
  semantics: {
    mechanicallyDerived: true;
    recommendation: false;
    authority: 'read-only-summary';
  };
}

export interface ObjectiveProgressOptions {
  now?: () => Date;
}

function countStatuses(tasks: WorkTask[]): ObjectiveProgressCounts {
  const counts: ObjectiveProgressCounts = {
    total: tasks.length,
    succeeded: 0,
    failed: 0,
    blocked: 0,
    cancelled: 0,
    running: 0,
    ready: 0,
    pending: 0,
    succeededRatio: 0
  };
  for (const task of tasks) {
    if (task.status === 'succeeded') counts.succeeded += 1;
    else if (task.status === 'failed') counts.failed += 1;
    else if (task.status === 'blocked') counts.blocked += 1;
    else if (task.status === 'cancelled') counts.cancelled += 1;
    else if (task.status === 'running') counts.running += 1;
    else if (task.status === 'ready') counts.ready += 1;
    else if (task.status === 'pending') counts.pending += 1;
  }
  counts.succeededRatio = counts.total === 0
    ? 0
    : Number((counts.succeeded / counts.total).toFixed(4));
  return counts;
}

function attemptByTask(attempts: TaskAttemptRecord[]): Map<string, TaskAttemptRecord> {
  const map = new Map<string, TaskAttemptRecord>();
  for (const attempt of attempts) {
    if (!map.has(attempt.taskId)) map.set(attempt.taskId, attempt);
  }
  return map;
}

function compactTask(
  task: WorkTask,
  aware: SchedulerAwareTask | undefined,
  latestAttempt: TaskAttemptRecord | undefined
): ObjectiveTaskSummary {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    generation: task.generation,
    ...(task.execution?.kind === 'engineering-workflow' ? { workflow: task.execution.workflow } : {}),
    ...(task.execution?.kind === 'worker-provider' ? { providerId: task.execution.providerId } : {}),
    ...(aware ? { availability: aware.availability } : {}),
    ...(aware?.waitReason ? { waitReason: aware.waitReason } : {}),
    ...(latestAttempt ? {
      latestAttempt: {
        id: latestAttempt.id,
        generation: latestAttempt.generation,
        status: latestAttempt.status,
        updatedAt: latestAttempt.updatedAt,
        ...(latestAttempt.error ? { error: latestAttempt.error } : {})
      }
    } : {})
  };
}

function blockerFromTask(
  task: WorkTask,
  aware: SchedulerAwareTask | undefined
): ObjectiveBlocker | undefined {
  if (aware?.availability === 'waiting-resource') {
    return {
      taskId: task.id,
      title: task.title,
      kind: 'waiting-resource',
      reason: aware.waitReason ?? 'RESOURCE_BUSY',
      resourceIds: [...new Set((aware.blockingResources ?? []).map(item => item.resourceId))].slice(0, 8)
    };
  }
  if (aware?.availability === 'waiting-session') {
    return {
      taskId: task.id,
      title: task.title,
      kind: 'waiting-session',
      reason: aware.waitReason ?? 'SESSION_BUSY',
      sessionIds: [...new Set(aware.blockingSessionIds ?? [])].slice(0, 8)
    };
  }
  if (aware?.availability === 'waiting-node') {
    return {
      taskId: task.id,
      title: task.title,
      kind: 'waiting-node',
      reason: aware.waitReason ?? 'NODE_INTERLOCK_ACTIVE'
    };
  }
  if (aware?.availability === 'waiting-provider') {
    return {
      taskId: task.id,
      title: task.title,
      kind: 'waiting-provider',
      reason: aware.waitReason ?? 'WORKER_PROVIDER_UNAVAILABLE'
    };
  }
  if (task.status === 'failed') {
    return {
      taskId: task.id,
      title: task.title,
      kind: 'task-failed',
      reason: task.error ?? 'task-failed'
    };
  }
  if (task.status === 'blocked') {
    return {
      taskId: task.id,
      title: task.title,
      kind: 'task-blocked',
      reason: task.error ?? 'blocked-by-dependency'
    };
  }
  if (task.status === 'cancelled') {
    return {
      taskId: task.id,
      title: task.title,
      kind: 'task-cancelled',
      reason: task.error ?? 'cancelled'
    };
  }
  return undefined;
}

export class ObjectiveProgressService {
  private readonly now: () => Date;

  constructor(
    private readonly taskGraphs: TaskGraphStore,
    private readonly taskAttempts: TaskAttemptStore,
    private readonly schedulerAwareness: SchedulerAwarenessService,
    private readonly workSessions: WorkSessionStore,
    options: ObjectiveProgressOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async summary(
    objectiveId: string,
    options: { taskLimit?: number; blockerLimit?: number; actionableLimit?: number } = {}
  ): Promise<ObjectiveProgressSummary> {
    const taskLimit = Math.max(1, Math.min(options.taskLimit ?? 64, 128));
    const blockerLimit = Math.max(1, Math.min(options.blockerLimit ?? 16, 32));
    const actionableLimit = Math.max(1, Math.min(options.actionableLimit ?? 16, 32));

    const [objective, attempts, awareness, sessions] = await Promise.all([
      this.taskGraphs.get(objectiveId),
      this.taskAttempts.list({ objectiveId, limit: 200 }),
      this.schedulerAwareness.snapshot(objectiveId, 128),
      this.workSessions.list(false)
    ]);

    const awareByTask = new Map(awareness.plan.map(item => [item.task.id, item]));
    const latestByTask = attemptByTask(attempts);
    const orderedTasks = [...objective.tasks].sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));

    const tasks = orderedTasks
      .slice(0, taskLimit)
      .map(task => compactTask(task, awareByTask.get(task.id), latestByTask.get(task.id)));
    const activeTasks = orderedTasks
      .filter(task => task.status === 'running')
      .slice(0, 16)
      .map(task => compactTask(task, awareByTask.get(task.id), latestByTask.get(task.id)));

    const blockers = orderedTasks
      .map(task => blockerFromTask(task, awareByTask.get(task.id)))
      .filter((item): item is ObjectiveBlocker => Boolean(item))
      .slice(0, blockerLimit);

    const latestFailureAttempt = attempts.find(attempt =>
      attempt.status === 'failed' ||
      attempt.status === 'blocked' ||
      attempt.status === 'interrupted'
    );
    const latestFailureTask = latestFailureAttempt
      ? objective.tasks.find(task => task.id === latestFailureAttempt.taskId)
      : undefined;

    const nextActionable = awareness.plan
      .filter(item => item.availability === 'ready' && item.task.status === 'ready')
      .slice(0, actionableLimit)
      .map(item => ({
        taskId: item.task.id,
        title: item.task.title,
        priority: item.task.priority,
        ...(item.task.execution?.kind === 'engineering-workflow' ? { workflow: item.task.execution.workflow } : {}),
        ...(item.task.execution?.kind === 'worker-provider' ? { providerId: item.task.execution.providerId } : {})
      }));

    const workSession = sessions.find(session => session.id === objective.workSessionId);
    const resources = awareness.resources
      .slice(0, 32)
      .map(item => ({
        resourceId: item.resourceId,
        mode: item.mode,
        ownerId: item.ownerId
      }));
    const nodeInterlocks = awareness.nodeInterlocks
      .slice(0, 16)
      .map(item => ({
        id: item.id,
        kind: item.kind,
        workSessionId: item.workSessionId,
        label: item.label
      }));

    return {
      objective: {
        id: objective.id,
        name: objective.name,
        status: objective.status,
        workSessionId: objective.workSessionId,
        updatedAt: objective.updatedAt
      },
      progress: countStatuses(objective.tasks),
      tasks,
      omittedTaskCount: Math.max(0, objective.tasks.length - tasks.length),
      activeTasks,
      blockers,
      latestFailure: latestFailureAttempt && latestFailureTask ? {
        attemptId: latestFailureAttempt.id,
        taskId: latestFailureAttempt.taskId,
        taskTitle: latestFailureTask.title,
        generation: latestFailureAttempt.generation,
        status: latestFailureAttempt.status,
        updatedAt: latestFailureAttempt.updatedAt,
        ...(latestFailureAttempt.error ? { error: latestFailureAttempt.error } : {})
      } : null,
      nextActionable,
      workSession: workSession ? {
        id: workSession.id,
        ...(workSession.name ? { name: workSession.name } : {}),
        updatedAt: workSession.updatedAt,
        ...(workSession.capsule.project?.worktreePath ? { worktreePath: workSession.capsule.project.worktreePath } : {}),
        ...(workSession.capsule.project?.buildDir ? { buildDir: workSession.capsule.project.buildDir } : {}),
        ...(workSession.capsule.project?.branch ? { branch: workSession.capsule.project.branch } : {}),
        ...(workSession.capsule.project?.commit ? { commit: workSession.capsule.project.commit } : {})
      } : null,
      resources,
      nodeInterlocks,
      generatedAt: this.now().toISOString(),
      semantics: {
        mechanicallyDerived: true,
        recommendation: false,
        authority: 'read-only-summary'
      }
    };
  }
}
