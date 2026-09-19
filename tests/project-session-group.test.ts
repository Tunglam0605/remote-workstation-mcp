import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProjectSessionGroupService, ProjectSessionGroupStore } from '../src/project-session-group.js';
import { WorkSessionStore } from '../src/work-session.js';

test('Project Session Group binds only caller-owned Work Sessions from one project', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-project-group-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const sessionsFile = path.join(root, 'sessions.json');
  const groupsFile = path.join(root, 'groups.json');
  const sessions = new WorkSessionStore('openai-tunnel', { file: sessionsFile });
  const groups = new ProjectSessionGroupStore('openai-tunnel', { file: groupsFile });
  const service = new ProjectSessionGroupService(groups, sessions);

  const first = await sessions.create({ name: 'first', workspace: 'projects', projectPath: 'repo', role: 'implementer' });
  const second = await sessions.create({ name: 'second', workspace: 'projects', projectPath: 'repo', role: 'reviewer' });
  const view = await service.create({ name: 'repo-parallel', sessionIds: [first.id, second.id] });

  assert.equal(view.group.workspace, 'projects');
  assert.equal(view.group.projectPath, 'repo');
  assert.deepEqual(view.group.memberSessionIds, [first.id, second.id]);
  assert.equal(view.authority, 'coordination-only');
  assert.equal(view.executionActive, false);
  assert.deepEqual(view.members.map(item => item.status), ['created', 'created']);

  const mismatched = await sessions.create({ workspace: 'projects', projectPath: 'other-repo' });
  await assert.rejects(
    () => service.addSession(view.group.id, mismatched.id),
    /same workspace\/projectPath/
  );

  const closing = await sessions.create({ workspace: 'projects', projectPath: 'repo' });
  await sessions.beginClose(closing.id);
  await assert.rejects(
    () => service.addSession(view.group.id, closing.id),
    /is closing and cannot join/
  );

  assert.equal((await sessions.inspect(first.id, true)).status, 'created');
  assert.equal((await sessions.inspect(second.id, true)).status, 'created');
});

test('active group membership is unique and group close has no Work Session side effects', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-project-group-membership-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const sessions = new WorkSessionStore('openai-tunnel', { file: path.join(root, 'sessions.json') });
  const groupStore = new ProjectSessionGroupStore('openai-tunnel', { file: path.join(root, 'groups.json') });
  const service = new ProjectSessionGroupService(groupStore, sessions);
  const first = await sessions.create({ workspace: 'projects', projectPath: 'repo' });
  const second = await sessions.create({ workspace: 'projects', projectPath: 'repo' });

  const one = await service.create({ sessionIds: [first.id] });
  await assert.rejects(
    () => service.create({ sessionIds: [first.id, second.id] }),
    /already belongs to active Project Session Group/
  );

  const withSecond = await service.addSession(one.group.id, second.id);
  assert.equal(withSecond.group.memberSessionIds.length, 2);
  await service.removeSession(one.group.id, second.id);
  await assert.rejects(
    () => service.removeSession(one.group.id, first.id),
    /Cannot remove the last Work Session/
  );

  const closed = await service.close(one.group.id);
  assert.equal(closed.group.status, 'closed');
  assert.equal(closed.executionActive, false);
  assert.equal((await sessions.inspect(first.id, true)).status, 'created');

  const two = await service.create({ sessionIds: [first.id, second.id] });
  assert.equal(two.group.status, 'active');
});

test('Project Session Groups are principal-scoped and closed records are bounded by GC', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-project-group-principal-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const sessionsFile = path.join(root, 'sessions.json');
  const groupsFile = path.join(root, 'groups.json');
  let now = new Date('2026-09-20T00:00:00.000Z');

  const sessionsA = new WorkSessionStore('principal-a', { file: sessionsFile, now: () => now });
  const storeA = new ProjectSessionGroupStore('principal-a', {
    file: groupsFile,
    now: () => now,
    terminalRetentionMs: 0,
    gcMaxRecords: 1
  });
  const serviceA = new ProjectSessionGroupService(storeA, sessionsA);
  const member = await sessionsA.create({ workspace: 'projects', projectPath: 'repo' });
  const created = await serviceA.create({ sessionIds: [member.id] });

  const sessionsB = new WorkSessionStore('principal-b', { file: sessionsFile, now: () => now });
  const storeB = new ProjectSessionGroupStore('principal-b', { file: groupsFile, now: () => now });
  const serviceB = new ProjectSessionGroupService(storeB, sessionsB);
  await assert.rejects(() => serviceB.get(created.group.id), /Unknown Project Session Group/);
  await assert.rejects(() => serviceB.create({ sessionIds: [member.id] }), /Unknown Work Session/);

  await serviceA.close(created.group.id);
  now = new Date('2026-09-20T00:01:00.000Z');
  assert.equal(await storeA.garbageCollect(), 1);
  assert.equal((await storeA.list(true)).length, 0);
});
