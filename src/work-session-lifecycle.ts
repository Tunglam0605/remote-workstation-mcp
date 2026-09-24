import { WorkSessionStore, type WorkSession } from './work-session.js';
import { WorktreeManager, type WorktreeState } from './worktree-manager.js';

export interface WorkSessionRuntimeResourceState {
  processes: number;
  terminals: number;
  serialSessions: number;
  debugSessions: number;
  hardwareLeases: number;
  nodeInterlocks: number;
  browserSessions?: number;
  existingChromeSessions?: number;
}

export interface WorkSessionCloseResult {
  state: 'closed' | 'needs-owner-or-explicit-action';
  session: WorkSession;
  runtime: WorkSessionRuntimeResourceState;
  worktree: WorktreeState;
  cleanupPerformed: false;
  reason?: string;
}

export type WorkSessionLifecycleClass = 'active' | 'stale' | 'closing' | 'terminal';

export type WorkSessionLifecycleBlocker =
  | 'RUNTIME_RESOURCES_ACTIVE'
  | 'WORKTREE_DIRTY'
  | 'SESSION_CLOSING'
  | 'SESSION_TERMINAL'
  | 'WORKTREE_NOT_CONFIGURED';

export interface WorkSessionLifecyclePreview {
  session: WorkSession;
  lifecycleClass: WorkSessionLifecycleClass;
  runtime: WorkSessionRuntimeResourceState;
  worktree: WorktreeState;
  close: {
    eligible: boolean;
    blockers: WorkSessionLifecycleBlocker[];
  };
  cleanup: {
    eligible: boolean;
    blockers: WorkSessionLifecycleBlocker[];
  };
  authority: 'read-only-preview';
  executionActive: false;
}

export type WorkSessionRuntimeSnapshot = (
  sessionId: string
) => Promise<WorkSessionRuntimeResourceState>;

function activeResourceCount(state: WorkSessionRuntimeResourceState): number {
  return (
    state.processes +
    state.terminals +
    state.serialSessions +
    state.debugSessions +
    state.hardwareLeases +
    state.nodeInterlocks +
    (state.browserSessions ?? 0) +
    (state.existingChromeSessions ?? 0)
  );
}

function lifecycleClass(session: WorkSession): WorkSessionLifecycleClass {
  if (session.status === 'closed' || session.status === 'expired') return 'terminal';
  if (session.status === 'closing') return 'closing';
  if (session.status === 'idle' || session.status === 'recovering') return 'stale';
  return 'active';
}

export class WorkSessionLifecycleService {
  constructor(
    private readonly sessions: WorkSessionStore,
    private readonly worktrees: WorktreeManager,
    private readonly runtimeSnapshot: WorkSessionRuntimeSnapshot
  ) {}

  async preview(sessionId: string): Promise<WorkSessionLifecyclePreview> {
    const session = await this.sessions.inspect(sessionId, true);
    const runtime = await this.runtimeSnapshot(sessionId);
    const worktree = await this.worktrees.status(sessionId);
    const resourcesActive = activeResourceCount(runtime) > 0;
    const dirty = worktree.dirty === true;
    const terminal = session.status === 'closed' || session.status === 'expired';
    const closing = session.status === 'closing';
    const worktreeConfigured = Boolean(worktree.worktreePath) && worktree.cleanupState !== 'not-configured';

    const closeBlockers: WorkSessionLifecycleBlocker[] = [];
    if (resourcesActive) closeBlockers.push('RUNTIME_RESOURCES_ACTIVE');
    if (dirty) closeBlockers.push('WORKTREE_DIRTY');
    if (closing) closeBlockers.push('SESSION_CLOSING');
    if (terminal) closeBlockers.push('SESSION_TERMINAL');

    const cleanupBlockers: WorkSessionLifecycleBlocker[] = [];
    if (!worktreeConfigured) cleanupBlockers.push('WORKTREE_NOT_CONFIGURED');
    if (resourcesActive) cleanupBlockers.push('RUNTIME_RESOURCES_ACTIVE');
    if (dirty) cleanupBlockers.push('WORKTREE_DIRTY');

    return {
      session,
      lifecycleClass: lifecycleClass(session),
      runtime,
      worktree,
      close: {
        eligible: closeBlockers.length === 0,
        blockers: closeBlockers
      },
      cleanup: {
        eligible: cleanupBlockers.length === 0,
        blockers: cleanupBlockers
      },
      authority: 'read-only-preview',
      executionActive: false
    };
  }

  async close(sessionId: string): Promise<WorkSessionCloseResult> {
    await this.sessions.beginClose(sessionId);
    try {
      const runtime = await this.runtimeSnapshot(sessionId);
      const worktree = await this.worktrees.status(sessionId);

      if (activeResourceCount(runtime) > 0) {
        const reason =
          'NEEDS_OWNER_OR_EXPLICIT_ACTION: Work Session still owns runtime resources; close never stops them implicitly.';
        const session = await this.sessions.abortClose(sessionId, reason);
        return {
          state: 'needs-owner-or-explicit-action',
          session,
          runtime,
          worktree,
          cleanupPerformed: false,
          reason
        };
      }

      if (worktree.dirty) {
        const reason =
          'NEEDS_OWNER_OR_EXPLICIT_ACTION: worktree has modified, staged or untracked content; close never deletes or cleans dirty work.';
        const session = await this.sessions.abortClose(sessionId, reason);
        return {
          state: 'needs-owner-or-explicit-action',
          session,
          runtime,
          worktree,
          cleanupPerformed: false,
          reason
        };
      }

      const session = await this.sessions.completeClose(sessionId);
      return {
        state: 'closed',
        session,
        runtime,
        worktree,
        cleanupPerformed: false
      };
    } catch (error) {
      await this.sessions.markRecovering(
        sessionId,
        'CLOSE_RECONCILIATION_REQUIRED: ' + (error instanceof Error ? error.message : String(error)).slice(0, 400)
      ).catch(() => undefined);
      throw error;
    }
  }
}
