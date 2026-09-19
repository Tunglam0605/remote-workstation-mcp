import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve('.');
const read = (relative: string) => fs.readFile(path.join(root, relative), 'utf8');

test('Engineering Workflow Engine exposes a frozen-snapshot-safe ChatGPT action contract', async () => {
  const tools = await read('src/tools/engineering-tools.ts');

  assert.match(tools, /const workflowId = z\.string\(\)[\s\S]*regex\(\/\^\[a-z0-9\]/);
  assert.doesNotMatch(tools, /const workflowId = z\.enum\(/);
  assert.match(tools, /workflowParameters = z\.record\([\s\S]*z\.unknown\(\)/);
  assert.match(tools, /engineering_workflow_plan[\s\S]*parameters: workflowParameters[\s\S]*overrides: legacyWorkflowOverrides/);
  assert.match(tools, /engineering_workflow_run[\s\S]*parameters: workflowParameters[\s\S]*overrides: legacyWorkflowOverrides/);
  assert.match(tools, /engineering_profile_init[\s\S]*profile: z\.record\(z\.string\(\), z\.unknown\(\)\)\.optional\(\)/);

  const legacyStart = tools.indexOf('const legacyWorkflowOverrides = z.object({');
  const runtimeStart = tools.indexOf('const workflowRuntimeParameters = z.object({');
  const genericStart = tools.indexOf('const workflowParameters = z.record', runtimeStart);
  assert.ok(legacyStart >= 0 && runtimeStart > legacyStart && genericStart > runtimeStart);
  const legacyBlock = tools.slice(legacyStart, runtimeStart);
  const runtimeBlock = tools.slice(runtimeStart, genericStart);
  assert.doesNotMatch(legacyBlock, /keepMonitorOpen/);
  assert.match(runtimeBlock, /keepMonitorOpen: z\.boolean\(\)\.optional\(\)/);

  // Action schema v3 retains the legacy v2 override shape while Work Session parameters
  // continue to flow through the generic envelope and internal runtime validation.
  assert.match(tools, /workflowRuntimeParameters\.parse\(\{ \.\.\.\(overrides \?\? \{\}\), \.\.\.parameters \}\)/);
});

test('v0.15 Work Session tools intentionally bump ChatGPT Action Schema to v3 and Engineering API to v4', async () => {
  const capabilities = await read('src/capabilities.ts');
  assert.match(capabilities, /export const ACTION_SCHEMA_VERSION = 3;/);
  assert.match(capabilities, /export const ENGINEERING_API_VERSION = 4;/);
  assert.match(capabilities, /export const SERVER_VERSION = '0\.15\.0';/);
  assert.match(capabilities, /multi_device\.data_plane/);
  assert.match(capabilities, /multi_device\.control_plane_relay/);
  assert.match(capabilities, /multi_device\.authorization/);
});

test('Keil remains a typed provider rather than an arbitrary command surface', async () => {
  const firmware = await read('src/adapters/engineering/firmware.ts');
  const profile = await read('src/adapters/engineering/project-profile.ts');

  assert.match(firmware, /discoverKeilUv4/);
  assert.match(firmware, /\['-j0', '-b', projectAbsolute, `-t\$\{target\}`, `-o\$\{logPath\}`\]/);
  assert.match(firmware, /project\.targets\?\.find/);
  assert.match(firmware, /Keil target '\$\{target\}'.*was not found in inspected \.uvprojx metadata/);
  assert.doesNotMatch(profile, /command:/);
  assert.doesNotMatch(profile, /args:/);
});


test('v0.15 Work Session routing uses Action Schema v3 and Keil shared outputs are project-variant exclusive', async () => {
  const capabilities = await read('src/capabilities.ts');
  const coreTools = await read('src/tools/core-tools.ts');
  const engineeringTools = await read('src/tools/engineering-tools.ts');
  const firmware = await read('src/adapters/engineering/firmware.ts');

  assert.match(capabilities, /export const ACTION_SCHEMA_VERSION = 3;/);
  assert.match(coreTools, /work_session_create/);
  assert.match(coreTools, /work_session_resume/);
  assert.match(coreTools, /work_session_worktree_prepare/);
  assert.match(engineeringTools, /workSessionId: z\.string\(\)\.uuid\(\)\.optional\(\)/);
  assert.match(engineeringTools, /const \{ workSessionId, \.\.\.runtimeParameters \} = parsed/);
  assert.match(engineeringTools, /ctx\.runInWorkSession\(workSessionId/);
  assert.match(engineeringTools, /ctx\.workflowRuns\.begin\(workspace, projectPath, workflow\)/);
  assert.match(engineeringTools, /ctx\.workflowRuns\.finish\(run\.id/);

  assert.match(firmware, /project-variant:keil:\$\{workspace\}:\$\{projectPath\}:\$\{projectFile\}:\$\{target\}/);
  assert.match(firmware, /this\.resources\.withLease\(buildResourceId, 'building'/);
});
