import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ProjectCoordinationService,
  type ProjectWorktreeStatusProvider
} from '../src/project-coordination.js';
import { WorkSessionStore } from '../src/work-session.js';
import type { WorktreeState } from '../src/worktree-manager.js';

class FakeWorktrees implements ProjectWorktreeStatusProvider {
  private readonly states = new Map<string, WorktreeState | Error>();

  set(sessionId: string, state: WorktreeState | Error): void {
    this.states.set(sessionId, state);
  }

  async status(sessionId: string): Promise<WorktreeState> {
    const state = this.states.get(sessionId);
    if (state instanceof Error) throw state;
    if (state) return structuredClone(state);
    return {
      sessionId,
      workspace: 'projects',
      repoPath: 'repo',
      cleanupState: 'not-configured'
    };
  }
}

test('Project Coordination status is caller-scoped, project-scoped and read-only', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-project-coordination-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'sessions.json');
  const sessions = new WorkSessionStore('openai-tunnel', { file });
  const otherPrincipal = new WorkSessionStore('other-principal', { file });
  const worktrees = new FakeWorktrees();
  const service = new ProjectCoordinationService(sessions, worktrees);

  const implementer = await sessions.create({
    name: 'implementer',
    workspace: 'projects',
    projectPath: 'repo',
    objective: 'implement feature',
    role: 'implementer'
  });
  await sessions.checkpoint(implementer.id, { currentTask: 'edit service' });
  const reviewer = await sessions.create({
    name: 'reviewer',
    workspace: 'projects',
    projectPath: 'repo',
    objective: 'review feature',
    role: 'reviewer'
  });
  await sessions.create({ workspace: 'projects', projectPath: 'other-repo' });
  await otherPrincipal.create({ workspace: 'projects', projectPath: 'repo' });

  worktrees.set(implementer.id, {
    sessionId: implementer.id,
    workspace: 'projects',
    repoPath: 'repo',
    worktreePath: 'repo.rwmcp-a',
    branch: 'rwmcp/session/a',
    commit: 'abc123',
    dirty: true
  });
  worktrees.set(reviewer.id, {
    sessionId: reviewer.id,
    workspace: 'projects',
    repoPath: 'repo',
    cleanupState: 'not-configured'
  });

  const beforeStatus = (await sessions.inspect(implementer.id, true)).status;
  const status = await service.status('projects', 'repo');

  assert.equal(status.sessions.length, 2);
  assert.deepEqual(new Set(status.sessions.map(item => item.sessionId)), new Set([implementer.id, reviewer.id]));
  assert.equal(status.sessions.find(item => item.sessionId === implementer.id)?.currentTask, 'edit service');
  assert.equal(status.sessions.find(item => item.sessionId === implementer.id)?.worktree.state, 'available');
  assert.deepEqual(status.dirtyWorktreeSessionIds, [implementer.id]);
  assert.deepEqual(status.conflicts, []);
  assert.equal(status.authority, 'coordination-only');
  assert.equal(status.executionActive, false);
  assert.equal((await sessions.inspect(implementer.id, true)).status, beforeStatus);
});

test('Project Coordination reports shared-worktree conflicts without taking action', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-project-coordination-conflict-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const sessions = new WorkSessionStore('openai-tunnel', { file: path.join(root, 'sessions.json') });
  const worktrees = new FakeWorktrees();
  const service = new ProjectCoordinationService(sessions, worktrees);

  const first = await sessions.create({ workspace: 'projects', projectPath: 'repo' });
  const second = await sessions.create({ workspace: 'projects', projectPath: 'repo' });
  for (const session of [first, second]) {
    worktrees.set(session.id, {
      sessionId: session.id,
      workspace: 'projects',
      repoPath: 'repo',
      worktreePath: 'shared-worktree',
      branch: 'shared',
      commit: 'abc123',
      dirty: false
    });
  }

  const status = await service.status('projects', 'repo');
  assert.equal(status.conflicts.length, 1);
  assert.equal(status.conflicts[0]?.kind, 'shared-worktree');
  assert.deepEqual(new Set(status.conflicts[0]?.sessionIds), new Set([first.id, second.id]));
  assert.equal((await sessions.inspect(first.id, true)).status, 'created');
  assert.equal((await sessions.inspect(second.id, true)).status, 'created');
});

test('Project Coordination degrades boundedly when worktree status is unavailable', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-project-coordination-unavailable-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const sessions = new WorkSessionStore('openai-tunnel', { file: path.join(root, 'sessions.json') });
  const worktrees = new FakeWorktrees();
  const service = new ProjectCoordinationService(sessions, worktrees);
  const session = await sessions.create({ workspace: 'projects', projectPath: 'repo' });
  worktrees.set(session.id, new Error('host path detail must not leak'));

  const status = await service.status('projects', 'repo');
  assert.equal(status.sessions[0]?.worktree.state, 'unavailable');
  assert.deepEqual(status.sessions[0]?.worktree, {
    state: 'unavailable',
    repoPath: 'repo',
    reason: 'WORKTREE_STATUS_UNAVAILABLE'
  });
});

test('Project Coordination enforces a bounded project snapshot', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-project-coordination-bounded-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const sessions = new WorkSessionStore('openai-tunnel', { file: path.join(root, 'sessions.json') });
  const service = new ProjectCoordinationService(sessions, new FakeWorktrees());

  for (let i = 0; i < 4; i += 1) {
    await sessions.create({ name: `session-${i}`, workspace: 'projects', projectPath: 'repo' });
  }

  const status = await service.status('projects', 'repo', { maxSessions: 2 });
  assert.equal(status.sessions.length, 2);
  assert.equal(status.truncated, true);
  await assert.rejects(() => service.status('projects', 'repo', { maxSessions: 0 }), /between 1 and 128/);
});


test('Project Coordination reports duplicate current-task labels as non-authoritative overlap signals', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-project-coordination-task-overlap-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const sessions = new WorkSessionStore('openai-tunnel', { file: path.join(root, 'sessions.json') });
  const service = new ProjectCoordinationService(sessions, new FakeWorktrees());

  const first = await sessions.create({ workspace: 'projects', projectPath: 'repo', role: 'implementer' });
  const second = await sessions.create({ workspace: 'projects', projectPath: 'repo', role: 'reviewer' });
  await sessions.checkpoint(first.id, { currentTask: 'Review OTA safety contract' });
  await sessions.checkpoint(second.id, { currentTask: '  review   OTA safety contract  ' });

  const status = await service.status('projects', 'repo');
  assert.equal(status.taskOverlapSignals.length, 1);
  assert.equal(status.taskOverlapSignals[0]?.kind, 'duplicate-current-task-label');
  assert.equal(status.taskOverlapSignals[0]?.interpretation, 'mechanical-signal-only');
  assert.deepEqual(new Set(status.taskOverlapSignals[0]?.sessionIds), new Set([first.id, second.id]));
  assert.equal(status.conflicts.length, 0);
});
