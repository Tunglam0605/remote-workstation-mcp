import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import YAML from 'yaml';
import { OwnerExecutionBridge } from '../src/setup/owner-execution.js';

async function fixture(t: test.TestContext, maxActiveProcesses = 8, maxResults = 100) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-owner-execution-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const project = path.join(root, 'project');
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, 'README.md'), 'fixture\n');
  await promisify(execFile)('git', ['init'], { cwd: project, windowsHide: true });
  const policyFile = path.join(root, 'policy.yaml');
  await fs.writeFile(policyFile, YAML.stringify({ version: 1, mode: 'workspace', workspaces: [{ id: 'w', root }], filesystem: { maxReadBytes: 1024, maxWriteBytes: 1024 }, process: { allowExecutables: [path.basename(process.execPath)], inheritEnv: ['PATH'], maxOutputBytes: 1024, maxRuntimeMs: 5000 }, tasks: { probe: { program: process.execPath, args: ['-e', "console.log('ok');setTimeout(()=>{}, 1000)"], cwd: 'project' }, outside: { program: process.execPath, args: ['-e', "console.log('outside')"], cwd: '.' } } }));
  let scopes = ['workstation.read', 'workstation.write', 'workstation.execute'];
  const bridge = new OwnerExecutionBridge({ repoRoot: root, policyPath: policyFile, sessionStoreFile: path.join(root, 'owner-sessions.json'), auditPath: path.join(root, 'audit.jsonl'), maxActiveProcesses, maxResults, completedProcessRetentionMs: 1_000, readPermissionState: async () => ({ mode: 'workspace', httpScopes: scopes, allowHostFilesystem: false, allowRawShell: false, policyPath: policyFile, leasePath: path.join(root, 'lease.json') }), identity: { version: 1, id: 'local-node', name: 'Local', hostname: 'local', platform: process.platform, arch: process.arch, createdAt: new Date().toISOString() } });
  return { bridge, policyFile, sessionStoreFile: path.join(root, 'owner-sessions.json'), setScopes: (next: string[]) => { scopes = next; } };
}

test('catalog and typed local operations bind work to the selected local session', async t => {
  const { bridge } = await fixture(t);
  const catalog = await bridge.catalog();
  assert.equal(catalog.node.id, 'local-node');
  assert.deepEqual(catalog.operations, ['session-create', 'git-status', 'task-run', 'process-read', 'process-stop']);
  assert.deepEqual(catalog.tasks.map(task => Object.keys(task)), [['name'], ['name']]);
  const created = await bridge.execute({ op: 'session-create', nodeId: 'local-node', workspace: 'w', projectPath: 'project' });
  assert.equal(created.op, 'session-create');
  if (created.op !== 'session-create') throw new Error('unreachable');
  const status = await bridge.execute({ op: 'git-status', nodeId: 'local-node', sessionId: created.session.id });
  assert.equal(status.op, 'git-status');
  const started = await bridge.execute({ op: 'task-run', nodeId: 'local-node', sessionId: created.session.id, profile: 'probe' });
  assert.equal(started.op, 'task-run');
  if (started.op !== 'task-run') throw new Error('unreachable');
  assert.equal('args' in started.process, false);
  assert.equal('program' in started.process, false);
  const read = await bridge.execute({ op: 'process-read', nodeId: 'local-node', sessionId: created.session.id, processId: started.process.id });
  assert.equal(read.op, 'process-read');
});

test('discovers immediate Git projects without depending on configured tasks', async t => {
  const { bridge, policyFile } = await fixture(t);
  const policy = await fs.readFile(policyFile, 'utf8');
  await fs.writeFile(policyFile, policy.replace(/tasks:\n(?:  .+\n)+/, 'tasks: {}\n'));
  const catalog = await bridge.catalog();
  assert.deepEqual(catalog.tasks, []);
  assert.ok(catalog.workspaces[0]?.projectPaths.includes('project'));
  const created = await bridge.execute({ op: 'session-create', nodeId: 'local-node', workspace: 'w', projectPath: 'project' });
  assert.equal(created.op, 'session-create');
});

test('rejects unknown request fields, foreign nodes, cross-session processes and unsafe task binding', async t => {
  const { bridge } = await fixture(t);
  await assert.rejects(() => bridge.execute({ op: 'session-create', nodeId: 'local-node', workspace: 'w', projectPath: 'project', extra: true }), /Unknown request field/);
  await assert.rejects(() => bridge.execute({ op: 'session-create', nodeId: 'remote-node', workspace: 'w', projectPath: 'project' }), /local node/);
  const created = await bridge.execute({ op: 'session-create', nodeId: 'local-node', workspace: 'w', projectPath: 'project' });
  if (created.op !== 'session-create') throw new Error('unreachable');
  await assert.rejects(() => bridge.execute({ op: 'task-run', nodeId: 'local-node', sessionId: created.session.id, profile: 'unknown' }), /Unknown task profile/);
  await assert.rejects(() => bridge.execute({ op: 'task-run', nodeId: 'local-node', sessionId: created.session.id, profile: 'outside' }), /outside the selected Work Session project/);
  const started = await bridge.execute({ op: 'task-run', nodeId: 'local-node', sessionId: created.session.id, profile: 'probe' });
  if (started.op !== 'task-run') throw new Error('unreachable');
  const other = await bridge.execute({ op: 'session-create', nodeId: 'local-node', workspace: 'w', projectPath: 'project' });
  if (other.op !== 'session-create') throw new Error('unreachable');
  await assert.rejects(() => bridge.execute({ op: 'process-read', nodeId: 'local-node', sessionId: other.session.id, processId: started.process.id }), /Unknown process id/);
  await bridge.execute({ op: 'process-stop', nodeId: 'local-node', sessionId: created.session.id, processId: started.process.id });
});

test('retains completed output after exit and after stop', async t => {
  const { bridge } = await fixture(t);
  const created = await bridge.execute({ op: 'session-create', nodeId: 'local-node', workspace: 'w', projectPath: 'project' });
  if (created.op !== 'session-create') throw new Error('unreachable');
  const started = await bridge.execute({ op: 'task-run', nodeId: 'local-node', sessionId: created.session.id, profile: 'probe' });
  if (started.op !== 'task-run') throw new Error('unreachable');
  let read: Awaited<ReturnType<typeof bridge.execute>> | undefined;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    read = await bridge.execute({ op: 'process-read', nodeId: 'local-node', sessionId: created.session.id, processId: started.process.id });
    if (read.op === 'process-read' && read.process.status !== 'running') break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(read);
  assert.equal(read.op, 'process-read');
  if (read.op !== 'process-read') throw new Error('unreachable');
  assert.match(read.stdout.text, /ok/);
  const stopped = await bridge.execute({ op: 'process-stop', nodeId: 'local-node', sessionId: created.session.id, processId: started.process.id });
  assert.equal(stopped.op, 'process-stop');
  const afterStop = await bridge.execute({ op: 'process-read', nodeId: 'local-node', sessionId: created.session.id, processId: started.process.id });
  assert.equal(afterStop.op, 'process-read');
});

test('refreshes configured scopes and denies read-only execution', async t => {
  const { bridge, setScopes, policyFile } = await fixture(t);
  setScopes(['workstation.read']);
  await assert.rejects(() => bridge.execute({ op: 'session-create', nodeId: 'local-node', workspace: 'w', projectPath: 'project' }), /lacks required scope 'workstation.write'/);
  setScopes(['workstation.read', 'workstation.write']);
  const created = await bridge.execute({ op: 'session-create', nodeId: 'local-node', workspace: 'w', projectPath: 'project' });
  if (created.op !== 'session-create') throw new Error('unreachable');
  await assert.rejects(() => bridge.execute({ op: 'task-run', nodeId: 'local-node', sessionId: created.session.id, profile: 'probe' }), /lacks required scope 'workstation.execute'/);
  setScopes(['workstation.read', 'workstation.write', 'workstation.execute']);
  const policy = await fs.readFile(policyFile, 'utf8');
  await fs.writeFile(policyFile, policy.replace('mode: workspace', 'mode: read_only'));
  await assert.rejects(() => bridge.execute({ op: 'task-run', nodeId: 'local-node', sessionId: created.session.id, profile: 'probe' }), /read_only mode/);
});

test('allows Git status but denies task execution after a workspace becomes read-only', async t => {
  const { bridge, policyFile } = await fixture(t);
  const created = await bridge.execute({ op: 'session-create', nodeId: 'local-node', workspace: 'w', projectPath: 'project' });
  if (created.op !== 'session-create') throw new Error('unreachable');
  const policy = YAML.parse(await fs.readFile(policyFile, 'utf8')) as { workspaces: Array<{ readOnly?: boolean }> };
  policy.workspaces[0]!.readOnly = true;
  await fs.writeFile(policyFile, YAML.stringify(policy));
  const status = await bridge.execute({ op: 'git-status', nodeId: 'local-node', sessionId: created.session.id });
  assert.equal(status.op, 'git-status');
  await assert.rejects(
    () => bridge.execute({ op: 'task-run', nodeId: 'local-node', sessionId: created.session.id, profile: 'probe' }),
    /Workspace 'w' is read-only/
  );
});

test('bounds completed process retention by result count and TTL', async t => {
  const { bridge } = await fixture(t, 8, 1);
  const created = await bridge.execute({ op: 'session-create', nodeId: 'local-node', workspace: 'w', projectPath: 'project' });
  if (created.op !== 'session-create') throw new Error('unreachable');
  const first = await bridge.execute({ op: 'task-run', nodeId: 'local-node', sessionId: created.session.id, profile: 'probe' });
  if (first.op !== 'task-run') throw new Error('unreachable');
  await bridge.execute({ op: 'process-stop', nodeId: 'local-node', sessionId: created.session.id, processId: first.process.id });
  const second = await bridge.execute({ op: 'task-run', nodeId: 'local-node', sessionId: created.session.id, profile: 'probe' });
  if (second.op !== 'task-run') throw new Error('unreachable');
  await bridge.execute({ op: 'process-stop', nodeId: 'local-node', sessionId: created.session.id, processId: second.process.id });
  await bridge.catalog();
  await assert.rejects(() => bridge.execute({ op: 'process-read', nodeId: 'local-node', sessionId: created.session.id, processId: first.process.id }), /Unknown process id/);
  await new Promise(resolve => setTimeout(resolve, 1100));
  await bridge.catalog();
  await assert.rejects(() => bridge.execute({ op: 'process-read', nodeId: 'local-node', sessionId: created.session.id, processId: second.process.id }), /Unknown process id/);
});

test('serializes launches at the active-process cap', async t => {
  const { bridge } = await fixture(t, 1);
  const created = await bridge.execute({ op: 'session-create', nodeId: 'local-node', workspace: 'w', projectPath: 'project' });
  if (created.op !== 'session-create') throw new Error('unreachable');
  await Promise.all([
    bridge.execute({ op: 'task-run', nodeId: 'local-node', sessionId: created.session.id, profile: 'probe' }),
    bridge.execute({ op: 'task-run', nodeId: 'local-node', sessionId: created.session.id, profile: 'probe' })
  ]).then(() => assert.fail('expected active process cap')).catch(error => assert.match(String(error), /Active process limit/));
});

test('rejects closing, closed, expired-by-timestamp, and foreign work-session records', async t => {
  const { bridge, sessionStoreFile } = await fixture(t);
  const created = await bridge.execute({ op: 'session-create', nodeId: 'local-node', workspace: 'w', projectPath: 'project' });
  if (created.op !== 'session-create') throw new Error('unreachable');
  const state = JSON.parse(await fs.readFile(sessionStoreFile, 'utf8')) as { sessions: Array<{ id: string; status: string; principalId: string }> };
  state.sessions.find(session => session.id === created.session.id)!.status = 'closing';
  await fs.writeFile(sessionStoreFile, JSON.stringify(state));
  await assert.rejects(() => bridge.execute({ op: 'git-status', nodeId: 'local-node', sessionId: created.session.id }), /closing/);
  state.sessions.find(session => session.id === created.session.id)!.status = 'closed';
  await fs.writeFile(sessionStoreFile, JSON.stringify(state));
  await assert.rejects(() => bridge.execute({ op: 'git-status', nodeId: 'local-node', sessionId: created.session.id }), /closed/);
  const record = state.sessions.find(session => session.id === created.session.id)! as { status: string; lifecyclePolicy?: { expireAfterMinutes: number }; lastActivityAt?: string };
  record.status = 'active';
  record.lifecyclePolicy = { expireAfterMinutes: 1 };
  record.lastActivityAt = new Date(Date.now() - 2 * 60_000).toISOString();
  await fs.writeFile(sessionStoreFile, JSON.stringify(state));
  await assert.rejects(() => bridge.execute({ op: 'git-status', nodeId: 'local-node', sessionId: created.session.id }), /expired/);
  state.sessions[0]!.principalId = 'foreign-principal';
  await fs.writeFile(sessionStoreFile, JSON.stringify(state));
  await assert.rejects(() => bridge.execute({ op: 'git-status', nodeId: 'local-node', sessionId: created.session.id }), /Unknown Work Session/);
});
