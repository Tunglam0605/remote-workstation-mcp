import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ExecutionPolicyService } from '../src/execution-policy.js';
import { ObjectiveDecompositionService } from '../src/objective-decomposition.js';
import { runWithWorkSession } from '../src/security/execution-context.js';
import { normalizeSetupSettings } from '../src/setup/settings.js';
import { TaskGraphStore } from '../src/task-graph.js';
import { WorkerProviderRegistry } from '../src/worker-provider.js';
import type { WorkSession } from '../src/work-session.js';

const SESSION = '90909090-9090-4090-8090-909090909090';

async function fixture(t: test.TestContext, mode: 'all-three' | 'rwmcp-only' = 'all-three') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-decomposition-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const settings = normalizeSetupSettings({
    workspaceRoot: root,
    execution: {
      targetMode: mode,
      defaultMode: mode === 'rwmcp-only' ? 'rwmcp-only' : 'both',
      codexEnabled: mode !== 'rwmcp-only',
      antigravityEnabled: mode !== 'rwmcp-only',
      workerRoutingProfile: 'smart'
    }
  });
  const graphs = new TaskGraphStore('openai-tunnel', { file: path.join(root, 'objectives.json') });
  const policy = new ExecutionPolicyService({ file: path.join(root, 'policy.json'), loadSettings: async () => settings });
  const providers = new WorkerProviderRegistry();
  providers.register({
    descriptor: { id: 'codex-local', kind: 'codex', displayName: 'Codex', worktreeAssignment: true, progressReporting: false, cancellationIntent: true },
    status: async () => ({ availability: 'available' as const }),
    dispatch: async () => ({ status: 'succeeded' as const })
  });
  providers.register({
    descriptor: { id: 'antigravity-local', kind: 'antigravity', displayName: 'Antigravity', worktreeAssignment: true, progressReporting: false, cancellationIntent: true },
    status: async () => ({ availability: 'available' as const }),
    dispatch: async () => ({ status: 'succeeded' as const })
  });
  const worktree = path.join(root, 'worktree');
  const session = {
    version: 1, id: SESSION, principalId: 'openai-tunnel', status: 'active', name: 'test',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(),
    capsule: { version: 1, project: { workspace: 'projects', projectPath: 'repo', worktreePath: worktree, buildDir: path.join(worktree, 'build') }, validatedFacts: [], completedTasks: [], blockers: [], decisions: [], resourceState: [], pendingActions: [] }
  } as WorkSession;
  const sessions = { list: async () => [session] };
  const service = new ObjectiveDecompositionService(graphs, policy, providers, sessions, { loadSettings: async () => settings });
  return { graphs, service, worktree };
}

test('Objective decomposition assigns Antigravity to frontend and Codex to coding while resolving the DAG atomically', async t => {
  const { graphs, service, worktree } = await fixture(t);
  await runWithWorkSession(SESSION, async () => {
    const objective = await graphs.create({ name: 'Feature', objective: 'Frontend plus backend plus verification' });
    const result = await service.decompose(objective.id, {
      tasks: [
        { key: 'ui', title: 'Polish UI', intent: 'frontend-ui', execution: { kind: 'auto-worker' } },
        { key: 'api', title: 'Refactor API', intent: 'coding', execution: { kind: 'auto-worker' } },
        { key: 'verify', title: 'Run verification', intent: 'workstation', dependsOn: ['ui', 'api'], concurrencyOperation: 'build.isolated', concurrencyKey: path.join(worktree, 'build'), execution: { kind: 'engineering-workflow', workspace: 'projects', projectPath: 'repo', workflow: 'project.verify', parameters: {} } }
      ]
    });
    assert.equal(result.atomic, true);
    const ui = result.tasks.find(task => task.planning?.key === 'ui')!;
    const api = result.tasks.find(task => task.planning?.key === 'api')!;
    const verify = result.tasks.find(task => task.planning?.key === 'verify')!;
    assert.deepEqual(ui.execution, { kind: 'worker-provider', providerId: 'antigravity-local' });
    assert.deepEqual(api.execution, { kind: 'worker-provider', providerId: 'codex-local' });
    assert.equal(ui.concurrency.operation, 'source.edit');
    assert.equal(ui.concurrency.key, worktree);
    assert.equal(api.concurrency.key, worktree);
    assert.deepEqual(new Set(verify.dependencies), new Set([ui.id, api.id]));
    assert.equal(result.assignments.find(item => item.key === 'ui')?.routePlan?.intent, 'frontend-ui');
  });
});

test('Objective decomposition fails closed when effective policy allows no AI worker and persists nothing', async t => {
  const { graphs, service } = await fixture(t, 'rwmcp-only');
  await runWithWorkSession(SESSION, async () => {
    const objective = await graphs.create({ name: 'No worker', objective: 'Must not widen owner policy' });
    await assert.rejects(
      service.decompose(objective.id, { tasks: [{ key: 'ui', title: 'UI', intent: 'frontend-ui', execution: { kind: 'auto-worker' } }] }),
      /NO_AI_TARGET_ALLOWED/
    );
    assert.equal((await graphs.get(objective.id)).tasks.length, 0);
  });
});

test('Objective decomposition rejects a local-key cycle before Task Graph mutation', async t => {
  const { graphs, service } = await fixture(t);
  await runWithWorkSession(SESSION, async () => {
    const objective = await graphs.create({ name: 'Cycle', objective: 'Reject cyclic planner output' });
    await assert.rejects(
      service.decompose(objective.id, { tasks: [
        { key: 'a', title: 'A', intent: 'coding', dependsOn: ['b'], execution: { kind: 'auto-worker' } },
        { key: 'b', title: 'B', intent: 'coding', dependsOn: ['a'], execution: { kind: 'auto-worker' } }
      ] }),
      /DECOMPOSITION_CYCLE/
    );
    assert.equal((await graphs.get(objective.id)).tasks.length, 0);
  });
});
