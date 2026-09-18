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
  assert.match(tools, /engineering_workflow_plan[\s\S]*parameters: workflowParameters/);
  assert.match(tools, /engineering_workflow_run[\s\S]*parameters: workflowParameters/);
  assert.match(tools, /engineering_profile_init[\s\S]*profile: z\.record\(z\.string\(\), z\.unknown\(\)\)\.optional\(\)/);

  // Backward-compatible typed fields may remain, but future workflow IDs and provider
  // parameters must be accepted through the generic server-validated envelopes above.
  assert.match(tools, /workflowOverrides\.parse\(\{ \.\.\.\(overrides \?\? \{\}\), \.\.\.parameters \}\)/);
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
