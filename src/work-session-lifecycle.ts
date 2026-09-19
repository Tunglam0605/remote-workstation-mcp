import { WorkSessionStore, type WorkSession } from './work-session.js';
import { WorktreeManager, type WorktreeState } from './worktree-manager.js';

export interface WorkSessionRuntimeResourceState {
  processes: number;
  terminals: number;
  serialSessions: number;
  debugSessions: number;
  hardwareLeases: number;
  nodeInterlocks: number;
}

export interface WorkSessionCloseResult {
  state: 'closed' | 'needs-owner-or-explicit-action';
  session: WorkSession;
  runtime: WorkSessionRuntimeResourceState;
  worktree: WorktreeState;
  cleanupPerformed: false;
  reason?: string;
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
    state.nodeInterlocks
  );
}

export class WorkSessionLifecycleService {
  constructor(
    private readonly sessions: WorkSessionStore,
    private readonly worktrees: WorktreeManager,
    private readonly runtimeSnapshot: WorkSessionRuntimeSnapshot
  ) {}

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
