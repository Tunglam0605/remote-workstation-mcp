import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

async function read(path: string): Promise<string> {
  return await fs.readFile(path, 'utf8');
}

test('project charter remains the authoritative product-direction guardrail', async () => {
  const charter = await read('docs/PROJECT_CHARTER.md');

  for (const heading of [
    '# Remote Workstation MCP Project Charter',
    '## 1. Mission',
    '## 2. North Star',
    '### 3.1 Core platform',
    '### 3.2 Engineering framework',
    '### 3.3 Domain extensions',
    '## 4. Architectural Invariants',
    '## 6. Non-Goals',
    '## 8. Change Decision Gate',
    '## 9. Priority Order',
    '## 10. Documentation Authority'
  ]) {
    assert.ok(charter.includes(heading), `missing charter heading: ${heading}`);
  }

  assert.ok(charter.includes('Direct Node first.'));
  assert.ok(charter.includes('Owner authority first.'));
  assert.ok(charter.includes('Typed operation first.'));
  assert.ok(charter.includes('Generic before specific.'));
  assert.ok(charter.includes('an STM32-only programmer/flasher'));
  assert.ok(charter.includes('dependent on one permanent master workstation'));
  assert.ok(charter.includes('Release notes describe what changed; **they do not redefine the mission**'));
});

test('entry-point documents link back to the project charter', async () => {
  const [readme, architecture, roadmap, contributing] = await Promise.all([
    read('README.md'),
    read('docs/ARCHITECTURE.md'),
    read('docs/ROADMAP.md'),
    read('CONTRIBUTING.md')
  ]);

  assert.ok(readme.includes('docs/PROJECT_CHARTER.md'));
  assert.ok(architecture.includes('PROJECT_CHARTER.md'));
  assert.ok(roadmap.includes('PROJECT_CHARTER.md'));
  assert.ok(contributing.includes('docs/PROJECT_CHARTER.md'));
  assert.ok(readme.includes('Release notes describe implementation history; they do not redefine the product mission.'));
  assert.ok(roadmap.includes('charter defines **why** the project exists'));
});
