import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve('.');
const read = (relative: string) => fs.readFile(path.join(root, relative), 'utf8');

test('Project Session Group and Controlled Worker Orchestration cannot become an authority shortcut', async () => {
  const capabilities = await read('src/capabilities.ts');
  const scopes = await read('src/security/request-principal.ts');
  const coreTools = await read('src/tools/core-tools.ts');
  const context = await read('src/context.ts');
  const groups = await read('src/project-session-group.ts');
  const providers = await read('src/worker-provider.ts');

  assert.match(capabilities, /project_session_group\.coordination/);
  assert.match(capabilities, /agent\.worker_provider_registry/);
  assert.match(capabilities, /agent\.orchestration'.*status: 'available'/);

  assert.match(scopes, /project_session_group_create: 'workstation\.write'/);
  assert.match(scopes, /project_session_group_inspect: 'workstation\.read'/);
  assert.match(scopes, /project_session_group_mutate: 'workstation\.write'/);
  assert.match(scopes, /worker_provider_list: 'workstation\.read'/);
  assert.match(scopes, /worker_route_plan: 'workstation\.read'/);
  assert.match(scopes, /work_objective_execute_task: 'workstation\.execute'/);
  assert.doesNotMatch(scopes, /project_session_group_(create|inspect|mutate): 'workstation\.execute'/);
  assert.doesNotMatch(scopes, /worker_provider_list: 'workstation\.execute'/);
  assert.doesNotMatch(scopes, /worker_provider_(dispatch|register|mutate)/);

  assert.match(coreTools, /project_session_group_create/);
  assert.match(coreTools, /project_session_group_inspect/);
  assert.match(coreTools, /project_session_group_mutate/);
  assert.match(coreTools, /worker_provider_list/);
  assert.match(coreTools, /kind: z\.literal\('worker-provider'\)/);
  assert.match(coreTools, /authority: 'registry-only'/);
  assert.match(coreTools, /executionActive: false/);
  assert.doesNotMatch(coreTools, /server\.registerTool\('worker_provider_(dispatch|register|mutate)'/);

  const workerStart = coreTools.indexOf("server.registerTool('worker_provider_list'");
  const workerEnd = coreTools.indexOf("server.registerTool('work_objective_create'", workerStart);
  assert.ok(workerStart >= 0 && workerEnd > workerStart);
  const workerBlock = coreTools.slice(workerStart, workerEnd);
  assert.doesNotMatch(workerBlock, /execute\(|dispatch\(|process_start|shell_exec|permission_|cross_node_transfer/);

  const executeStart = coreTools.indexOf("server.registerTool('work_objective_execute_task'");
  const executeEnd = coreTools.indexOf("server.registerTool('work_objective_cancel_task'", executeStart);
  assert.ok(executeStart >= 0 && executeEnd > executeStart);
  const executeBlock = coreTools.slice(executeStart, executeEnd);
  assert.doesNotMatch(executeBlock, /providerId|argv|shell_exec|process_start|permission_|cross_node_transfer/);

  assert.match(context, /new ProjectSessionGroupStore/);
  assert.match(context, /new ProjectSessionGroupService/);
  assert.match(context, /Project Session Group metadata is optional coordination state/);
  assert.match(context, /projectSessionGroupMaintenanceFailures/);
  assert.match(context, /new WorkerProviderRegistry/);

  assert.match(groups, /coordination-only/);
  assert.match(groups, /executionActive: false/);
  assert.match(groups, /same workspace\/projectPath/);
  assert.doesNotMatch(groups, /workstation\.execute|shell_exec|process_start|grant|crossNode/);

  assert.match(providers, /registry-only/);
  assert.match(providers, /executionActive: activeDispatches > 0/);
  assert.match(providers, /activeDispatchCounts/);
  assert.match(providers, /status probe timed out/);
  assert.match(providers, /redacted provider detail/);
  assert.match(providers, /async dispatch\(providerId:/);
  assert.match(providers, /Unknown worker provider/);
  assert.match(providers, /requires an isolated Work Session worktree before dispatch/);
  assert.doesNotMatch(providers, /shell_exec|process_start|workstation\.execute|workstation\.full_control|cross_node_transfer/);
});
