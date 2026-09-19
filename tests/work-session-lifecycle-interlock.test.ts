import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const read = (path: string) => fs.readFile(path, 'utf8');

test('workflow execution owns a node lifecycle interlock for its complete run', async () => {
  const tools = await read('src/tools/engineering-tools.ts');
  const execution = await read('src/engineering-workflow-execution.ts');
  assert.match(tools, /ctx\.engineering\.execution\.run/);
  assert.match(execution, /this\.nodeInterlocks\.acquireWorkflow/);
  assert.match(execution, /finally\s*\{[\s\S]*this\.nodeInterlocks\.release\(interlock\.id\)/);
});

test('Windows restart update and rollback fail closed on active Work Session interlocks', async () => {
  const helper = await read('scripts/work-session-interlock-windows.ps1');
  const runtime = await read('scripts/runtime-control-windows.ps1');
  const launcher = await read('scripts/rwmcp-launcher-windows.ps1');

  assert.match(helper, /work-session-interlocks\.json/);
  assert.match(helper, /Get-Process -Id \$pidValue/);
  assert.match(helper, /NODE_BUSY/);
  assert.match(helper, /Assert-NoRwmcpActiveWorkSessionInterlocks/);

  assert.match(runtime, /work-session-interlock-windows\.ps1/);
  assert.match(runtime, /Action -eq 'Restart'[\s\S]*Assert-NoRwmcpActiveWorkSessionInterlocks/);

  assert.match(launcher, /work-session-interlock-windows\.ps1/);
  assert.match(launcher, /'Restart'[\s\S]*Assert-NoRwmcpActiveWorkSessionInterlocks -Operation 'runtime restart'/);
  assert.match(launcher, /'Update'[\s\S]*Assert-NoRwmcpActiveWorkSessionInterlocks -Operation 'runtime update'/);
  assert.match(launcher, /'Rollback'[\s\S]*Assert-NoRwmcpActiveWorkSessionInterlocks -Operation 'runtime rollback'/);
});

test('Linux Control Center TUI and updater honor the same Work Session lifecycle interlock', async () => {
  const setup = await read('src/setup/setup-server.ts');
  const tui = await read('src/tui/config.ts');
  const updater = await read('scripts/update-user.mjs');

  assert.match(setup, /assertNoActiveWorkSessionInterlocks/);
  assert.match(setup, /action === 'Restart'[\s\S]*assertNoActiveWorkSessionInterlocks\('runtime restart'\)/);
  assert.match(setup, /windowsUpdateControl[\s\S]*action === 'Install'[\s\S]*assertNoActiveWorkSessionInterlocks\('runtime update'\)/);
  assert.match(setup, /linuxUpdateControl[\s\S]*action === 'Install'[\s\S]*assertNoActiveWorkSessionInterlocks\('runtime update'\)/);

  assert.match(tui, /NodeInterlockStore/);
  assert.match(tui, /NODE_BUSY/);
  assert.match(tui, /restartManagedRuntime/);

  assert.match(updater, /activeWorkSessionInterlocks/);
  assert.match(updater, /NODE_BUSY/);
  assert.match(updater, /updateDeferred: true/);
});

test('owner Stop remains available as an explicit recovery action', async () => {
  const runtime = await read('scripts/runtime-control-windows.ps1');
  const restartGuardIndex = runtime.indexOf("if ($Action -eq 'Restart')");
  const stopCaseIndex = runtime.indexOf("'Stop' {");
  assert.ok(restartGuardIndex >= 0);
  assert.ok(stopCaseIndex >= 0);
  assert.doesNotMatch(
    runtime.slice(stopCaseIndex, runtime.indexOf("'Restart' {", stopCaseIndex)),
    /Assert-NoRwmcpActiveWorkSessionInterlocks/
  );
});
