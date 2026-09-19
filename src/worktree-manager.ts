import path from 'node:path';
import { GitAdapter } from './adapters/git.js';
import { WorkSessionStore, type WorkSession } from './work-session.js';

export type WorktreeCleanupState =
  | 'removed'
  | 'not-configured'
  | 'needs-owner-or-explicit-action';

export interface WorktreePrepareOptions {
  workspace: string;
  repoPath?: string;
  startPoint?: string;
}

export interface WorktreeState {
  sessionId: string;
  workspace: string;
  repoPath: string;
  worktreePath?: string;
  branch?: string;
  commit?: string;
  buildDir?: string;
  dirty?: boolean;
  reused?: boolean;
  cleanupState?: WorktreeCleanupState;
  reason?: string;
}

function normalizeRepoPath(value: string | undefined): string {
  const normalized = (value ?? '.').trim() || '.';
  if (path.isAbsolute(normalized)) throw new Error('Worktree repoPath must remain workspace-relative.');
  if (normalized.split(/[\\/]+/).includes('..')) {
    throw new Error('Worktree repoPath must not escape the authorized workspace.');
  }
  return path.normalize(normalized);
}

function dirtyStatus(output: string): boolean {
  return output
    .split(/\r?\n/)
    .some(line => line.trim() !== '' && !line.startsWith('## '));
}

export class WorktreeManager {
  constructor(
    private readonly git: GitAdapter,
    private readonly sessions: WorkSessionStore
  ) {}

  private repoPath(session: WorkSession, requested?: string): string {
    const project = session.capsule.project;
    return normalizeRepoPath(requested ?? project?.repoPath ?? project?.projectPath ?? '.');
  }

  private generatedLocation(session: WorkSession, repoPath: string): { worktreePath: string; branch: string } {
    if (repoPath === '.') {
      throw new Error(
        'WORKTREE_WORKSPACE_BOUNDARY: repository root equals the authorized workspace root. ' +
        'Authorize a parent workspace before creating a sibling writable Work Session; RWMCP will not widen filesystem scope automatically.'
      );
    }
    const parent = path.dirname(repoPath);
    const repoName = path.basename(repoPath).replace(/[^A-Za-z0-9._-]+/g, '-');
    const worktreePath = path.join(parent, `${repoName}.rwmcp-${session.id}`);
    const branch = `rwmcp/session/${session.id}`;
    return { worktreePath, branch };
  }

  async prepare(sessionId: string, options: WorktreePrepareOptions): Promise<WorktreeState> {
    const session = await this.sessions.resume(sessionId);
    const workspace = options.workspace.trim();
    if (!workspace) throw new Error('workspace must not be empty.');
    if (session.capsule.project?.workspace && session.capsule.project.workspace !== workspace) {
      throw new Error('Work Session project workspace does not match the requested workspace.');
    }

    const repoPath = this.repoPath(session, options.repoPath);
    if (session.capsule.project?.worktreePath) {
      if (session.capsule.project.repoPath && session.capsule.project.repoPath !== repoPath) {
        throw new Error('Work Session already owns a worktree for a different repository.');
      }
      const status = await this.git.status(workspace, session.capsule.project.worktreePath);
      return {
        sessionId,
        workspace,
        repoPath,
        worktreePath: session.capsule.project.worktreePath,
        branch: session.capsule.project.branch,
        commit: session.capsule.project.commit,
        buildDir: session.capsule.project.buildDir,
        dirty: dirtyStatus(status),
        reused: true
      };
    }

    const generated = this.generatedLocation(session, repoPath);
    await this.git.addWorktree(
      workspace,
      generated.worktreePath,
      generated.branch,
      {
        repoPath,
        createBranch: true,
        startPoint: options.startPoint ?? 'HEAD'
      }
    );
    const commit = (await this.git.log(workspace, 1, generated.worktreePath))[0]?.hash;
    await this.sessions.updateProject(sessionId, {
      workspace,
      repoPath,
      worktreePath: generated.worktreePath,
      branch: generated.branch,
      ...(commit ? { commit } : {}),
      buildDir: path.join(generated.worktreePath, 'build')
    });

    return {
      sessionId,
      workspace,
      repoPath,
      worktreePath: generated.worktreePath,
      branch: generated.branch,
      commit,
      buildDir: path.join(generated.worktreePath, 'build'),
      dirty: false,
      reused: false
    };
  }

  async status(sessionId: string): Promise<WorktreeState> {
    const session = await this.sessions.resume(sessionId);
    const project = session.capsule.project;
    if (!project?.workspace || !project.worktreePath) {
      return {
        sessionId,
        workspace: project?.workspace ?? '',
        repoPath: project?.repoPath ?? project?.projectPath ?? '.',
        cleanupState: 'not-configured'
      };
    }
    const status = await this.git.status(project.workspace, project.worktreePath);
    return {
      sessionId,
      workspace: project.workspace,
      repoPath: project.repoPath ?? project.projectPath ?? '.',
      worktreePath: project.worktreePath,
      branch: project.branch,
      commit: project.commit,
      buildDir: project.buildDir,
      dirty: dirtyStatus(status)
    };
  }

  async cleanup(sessionId: string): Promise<WorktreeState> {
    const session = await this.sessions.resume(sessionId);
    const project = session.capsule.project;
    if (!project?.workspace || !project.worktreePath) {
      return {
        sessionId,
        workspace: project?.workspace ?? '',
        repoPath: project?.repoPath ?? project?.projectPath ?? '.',
        cleanupState: 'not-configured'
      };
    }

    const repoPath = project.repoPath ?? project.projectPath ?? '.';
    const status = await this.git.status(project.workspace, project.worktreePath);
    if (dirtyStatus(status)) {
      return {
        sessionId,
        workspace: project.workspace,
        repoPath,
        worktreePath: project.worktreePath,
        branch: project.branch,
        commit: project.commit,
        buildDir: project.buildDir,
        dirty: true,
        cleanupState: 'needs-owner-or-explicit-action',
        reason: 'NEEDS_OWNER_OR_EXPLICIT_ACTION: worktree has modified, staged or untracked content; force removal is intentionally unavailable.'
      };
    }

    await this.git.removeWorktree(project.workspace, project.worktreePath, false, repoPath);
    await this.sessions.updateProject(sessionId, {
      worktreePath: undefined,
      buildDir: undefined
    });
    return {
      sessionId,
      workspace: project.workspace,
      repoPath,
      branch: project.branch,
      commit: project.commit,
      dirty: false,
      cleanupState: 'removed'
    };
  }
}
