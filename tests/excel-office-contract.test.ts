import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

test('Excel Office pack remains typed, transactional and does not expose raw COM/VBA', async () => {
  const tools = await fs.readFile(path.resolve('src/tools/office-tools.ts'), 'utf8');
  const capabilities = await fs.readFile(path.resolve('src/capabilities.ts'), 'utf8');
  const scopes = await fs.readFile(path.resolve('src/security/request-principal.ts'), 'utf8');
  const native = await fs.readFile(path.resolve('scripts/office/excel-com.ps1'), 'utf8');
  assert.match(tools, /server\.registerTool\('excel_inspect'/);
  assert.match(tools, /server\.registerTool\('excel_edit'/);
  assert.match(scopes, /excel_inspect: 'workstation\.read'/);
  assert.match(scopes, /excel_edit: 'workstation\.write'/);
  assert.match(capabilities, /office\.excel\.inspect/);
  assert.match(capabilities, /office\.excel\.mutate/);
  assert.match(native, /AutomationSecurity = 3/);
  assert.match(native, /EnableEvents = \$false/);
  assert.match(native, /Workbooks\.Open\(\$workbookPath, 0, \$true/);
  assert.match(native, /CalculateFullRebuild/);
  assert.doesNotMatch(tools, /excel_com|excel_vba|raw_com|run_macro/i);
  assert.doesNotMatch(native, /Run\(|ExecuteExcel4Macro|VBProject|VBE/);
});
