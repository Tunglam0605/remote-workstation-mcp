import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

test('PowerPoint Office pack remains typed, transactional and does not expose raw COM/VBA', async () => {
  const tools = await fs.readFile(path.resolve('src/tools/office-tools.ts'), 'utf8');
  const capabilities = await fs.readFile(path.resolve('src/capabilities.ts'), 'utf8');
  const scopes = await fs.readFile(path.resolve('src/security/request-principal.ts'), 'utf8');
  const matrix = await fs.readFile(path.resolve('src/office/common/capability-matrix.ts'), 'utf8');
  const native = await fs.readFile(path.resolve('scripts/office/powerpoint-com.ps1'), 'utf8');
  assert.match(tools, /server\.registerTool\('powerpoint_inspect'/);
  assert.match(tools, /server\.registerTool\('powerpoint_edit'/);
  assert.match(scopes, /powerpoint_inspect: 'workstation\.read'/);
  assert.match(scopes, /powerpoint_edit: 'workstation\.write'/);
  assert.match(capabilities, /office\.powerpoint\.inspect/);
  assert.match(capabilities, /office\.powerpoint\.mutate/);
  assert.match(matrix, /'powerpoint\.inspect'/);
  assert.match(matrix, /'powerpoint\.edit'/);
  assert.match(matrix, /'powerpoint\.render'/);
  assert.match(native, /AutomationSecurity = 3/);
  assert.match(native, /Presentations\.Open\(\$presentationPath, -1, 0, 0\)/);
  assert.match(native, /SaveAs\(\$outputPdfPath, 32\)/);
  assert.doesNotMatch(tools, /powerpoint_com|powerpoint_vba|raw_com|run_macro/i);
  assert.doesNotMatch(native, /Run\(|VBProject|VBE|AddIns\.Add/);
});
