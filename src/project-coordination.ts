import path from 'node:path';
import type { WorkSession, WorkSessionStatus, WorkSessionStore } from './work-session.js';
import type { WorktreeState } from './worktree-manager.js';

export interface ProjectWorktreeStatusProvider {
  status(sessionId: string): Promise<WorktreeState>;
}

export type ProjectCoordinationWorktreeView =
  | {
      state: 'not-configured';
      repoPath: string;
    }
  | {
      state: 'available';
      repoPath: string;
      worktreePath: string;
      branch?: string;
      commit?: string;
      buildDir?: string;
      dirty: boolean;
    }
  | {
      state: 'unavailable';
      repoPath?: string;
      reason: 'WORKTREE_STATUS_UNAVAILABLE';
    };

export interface ProjectCoordinationSessionView {
  sessionId: string;
  status: WorkSessionStatus;
  name?: string;
  role?: string;
  currentObjective?: string;
  currentTask?: string;
  lastActivityAt: string;
  lifecycleReason?: string;
  worktree: ProjectCoordinationWorktreeView;
}

export interface ProjectCoordinationConflict {
  kind: 'shared-worktree';
  key: string;
  sessionIds: string[];
}

export interface ProjectCoordinationStatus {
  project: {
    workspace: string;
    projectPath: string;
  };
  sessions: ProjectCoordinationSessionView[];
  conflicts: ProjectCoordinationConflict[];
  dirtyWorktreeSessionIds: string[];
  recoveringSessionIds: string[];
  idleSessionIds: string[];
  truncated: boolean;
  authority: 'coordination-only';
  executionActive: false;
}

export interface ProjectCoordinationStatusOptions {
  includeClosed?: boolean;
  maxSessions?: number;
}

function bounded(value: string, field: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || normalized.includes('\0')) {
    throw new Error(`${field} must be non-empty text of at most ${maxLength} characters.`);
  }
  return normalized;
}

function normalizeProjectPath(value: string): string {
  const normalized = path.normalize(value.trim()).replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function sameProject(session: WorkSession, workspace: string, projectPath: string): boolean {
  const project = session.capsule.project;
  if (!project?.workspace || !project.projectPath) return false;
  return project.workspace === workspace && normalizeProjectPath(project.projectPath) === projectPath;
}

function boundedMaxSessions(value: number | undefined): number {
  if (value === undefined) return 32;
  if (!Number.isInteger(value) || value < 1 || value > 128) {
    throw new Error('maxSessions must be an integer between 1 and 128.');
  }
  return value;
}

export class ProjectCoordinationService {
  constructor(
    private readonly sessions: WorkSessionStore,
    private readonly worktrees: ProjectWorktreeStatusProvider
  ) {}

  private async worktreeView(session: WorkSession): Promise<ProjectCoordinationWorktreeView> {
    try {
      const state = await this.worktrees.status(session.id);
      if (!state.worktreePath || state.cleanupState === 'not-configured') {
        return {
          state: 'not-configured',
          repoPath: state.repoPath
        };
      }
      return {
        state: 'available',
        repoPath: state.repoPath,
        worktreePath: state.worktreePath,
        ...(state.branch ? { branch: state.branch } : {}),
        ...(state.commit ? { commit: state.commit } : {}),
        ...(state.buildDir ? { buildDir: state.buildDir } : {}),
        dirty: state.dirty === true
      };
    } catch {
      return {
        state: 'unavailable',
        ...(session.capsule.project?.repoPath || session.capsule.project?.projectPath
          ? { repoPath: session.capsule.project?.repoPath ?? session.capsule.project?.projectPath }
          : {}),
        reason: 'WORKTREE_STATUS_UNAVAILABLE'
      };
    }
  }

  async status(
    workspaceInput: string,
    projectPathInput: string,
    options: ProjectCoordinationStatusOptions = {}
  ): Promise<ProjectCoordinationStatus> {
    const workspace = bounded(workspaceInput, 'workspace', 128);
    const rawProjectPath = bounded(projectPathInput, 'projectPath', 1024);
    const projectPath = normalizeProjectPath(rawProjectPath);
    const maxSessions = boundedMaxSessions(options.maxSessions);

    const matches = (await this.sessions.list(options.includeClosed === true))
      .filter(session => sameProject(session, workspace, projectPath))
      .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt) || a.id.localeCompare(b.id));

    const truncated = matches.length > maxSessions;
    const selected = matches.slice(0, maxSessions);
    const views = await Promise.all(selected.map(async session => ({
      sessionId: session.id,
      status: session.status,
      ...(session.name ? { name: session.name } : {}),
      ...(session.capsule.role ? { role: session.capsule.role } : {}),
      ...(session.capsule.currentObjective ? { currentObjective: session.capsule.currentObjective } : {}),
      ...(session.capsule.currentTask ? { currentTask: session.capsule.currentTask } : {}),
      lastActivityAt: session.lastActivityAt,
      ...(session.lifecycleReason ? { lifecycleReason: session.lifecycleReason } : {}),
      worktree: await this.worktreeView(session)
    } satisfies ProjectCoordinationSessionView)));

    const byWorktree = new Map<string, string[]>();
    for (const view of views) {
      if (view.worktree.state !== 'available') continue;
      const key = normalizeProjectPath(view.worktree.worktreePath);
      const owners = byWorktree.get(key) ?? [];
      owners.push(view.sessionId);
      byWorktree.set(key, owners);
    }

    const conflicts = [...byWorktree.entries()]
      .filter(([, owners]) => owners.length > 1)
      .map(([key, owners]) => ({
        kind: 'shared-worktree' as const,
        key,
        sessionIds: [...owners].sort()
      }))
      .sort((a, b) => a.key.localeCompare(b.key));

    return {
      project: { workspace, projectPath: rawProjectPath },
      sessions: views,
      conflicts,
      dirtyWorktreeSessionIds: views
        .filter(view => view.worktree.state === 'available' && view.worktree.dirty)
        .map(view => view.sessionId),
      recoveringSessionIds: views.filter(view => view.status === 'recovering').map(view => view.sessionId),
      idleSessionIds: views.filter(view => view.status === 'idle').map(view => view.sessionId),
      truncated,
      authority: 'coordination-only',
      executionActive: false
    };
  }
}
