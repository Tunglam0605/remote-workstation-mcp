import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

async function read(path: string): Promise<string> {
  return await fs.readFile(path, 'utf8');
}

test('Windows managed install is one-time and startup uses the stable Boot action', async () => {
  const installer = await read('scripts/install-windows-release.ps1');
  const runtime = await read('scripts/runtime-control-windows.ps1');

  assert.match(installer, /ValidateSet\('Setup'.*'Boot'.*'UpdateCheck'.*'AutoUpdateOn'.*'AutoUpdateOff'/s);
  assert.match(installer, /updateScript = Join-Path \$CurrentRoot 'scripts\\update-windows\.ps1'/);
  assert.match(installer, /Test-Path \$updateScript/);
  assert.match(installer, /Initialize-AutoUpdate/);
  assert.match(installer, /Migrate-ExistingAutostart/);
  assert.match(installer, /Cleanup-VersionSlots/);
  assert.doesNotMatch(installer, /Require-OrInstall 'git'/);
  assert.match(installer, /Resolve-CommandPath 'node'/);
  assert.match(installer, /Resolve-CommandPath 'git' 'Git\.Git'/);
  assert.match(runtime, /stableAction = if \(\$runtimeMode -eq 'OpenAI'\) \{ 'Boot' \}/);
});

test('Windows updater defaults to stable automatic startup checks with failed-release backoff', async () => {
  const updater = await read('scripts/update-windows.ps1');

  assert.match(updater, /enabled = \$true/);
  assert.match(updater, /channel = 'stable'/);
  assert.match(updater, /checkOnStartup = \$true/);
  assert.match(updater, /retryFailedAfterHours/);
  assert.match(updater, /MarkFailed/);
  assert.match(updater, /retryAfter/);
  assert.match(updater, /RemoteWorkstationMCP\.Update/);
  assert.match(updater, /System\.Threading\.Mutex/);
  assert.match(updater, /releases\/latest/);
  assert.match(updater, /install-windows-release\.ps1/);
});

test('automatic boot update and manual update are distinct operations', async () => {
  const installer = await read('scripts/install-windows-release.ps1');
  const updater = await read('scripts/update-windows.ps1');

  assert.match(installer, /Invoke-Updater 'InstallAuto' -Quiet/);
  assert.match(installer, /Invoke-Updater 'Install'/);
  assert.match(updater, /ValidateSet\('Check','Install','InstallAuto'/);
  assert.match(updater, /\$Action -eq 'InstallAuto' -and -not \[bool\]\$state\.enabled/);
});

test('Windows Control Center refuses foreign port ownership and verifies its managed listener', async () => {
  const control = await read('scripts/control-center-windows.ps1');

  assert.match(control, /Get-LoopbackListenerOwner/);
  assert.match(control, /Get-NetTCPConnection/);
  assert.match(control, /Test-ProcessDescendant/);
  assert.match(control, /is already in use by process/);
  assert.match(control, /Test-OrphanedRwmcpControlCenter/);
  assert.match(control, /Recovering orphaned Remote Workstation Control Center/);
  assert.match(control, /managedPortOwned/);
  assert.match(control, /portOwnerPid/);
});

test('Windows restart is handed off outside the managed runtime tree and OpenAI runtime has a watchdog', async () => {
  const installer = await read('scripts/install-windows-release.ps1');
  const runtime = await read('scripts/runtime-control-windows.ps1');
  const host = await read('scripts/runtime-host-windows.ps1');
  const safeRestart = await read('scripts/safe-restart-windows.ps1');
  const handoff = await read('scripts/runtime-restart-handoff-windows.ps1');
  const setupServer = await read('src/setup/setup-server.ts');

  assert.match(installer, /safe-restart-windows\.ps1/);
  assert.match(runtime, /Direct Restart cannot run from inside the managed runtime process tree/);
  assert.match(safeRestart, /api\/runtime\/action/);
  assert.match(safeRestart, /Refusing a direct self-killing restart/);
  assert.match(handoff, /Start-Sleep -Milliseconds/);
  assert.match(setupServer, /scheduleWindowsRuntimeRestart/);
  assert.match(setupServer, /json\(res, 202, scheduleWindowsRuntimeRestart/);
  assert.match(host, /watchdog restart in/);
  assert.match(host, /restartDelaysSeconds = @\(1, 2, 5, 10, 30\)/);
  assert.match(host, /tunnel-readiness-lost/);
  assert.match(host, /connection-state\.json/);
  assert.match(runtime, /connectionState = \$connectionState/);
  assert.match(runtime, /'OFFLINE'/);
  assert.match(runtime, /'RECONNECTING'/);
  assert.match(runtime, /'ONLINE'/);
});
test('Windows managed upgrades self-heal the stable launcher from the current runtime slot', async () => {
  const installer = await read('scripts/install-windows-release.ps1');
  const runtime = await read('scripts/runtime-control-windows.ps1');
  const launcher = await read('scripts/rwmcp-launcher-windows.ps1');

  assert.match(installer, /rwmcp-launcher-windows\.ps1/);
  assert.match(runtime, /Sync-StableLauncherFromRuntimeSlot/);
  assert.match(runtime, /Get-FileHash/);
  assert.match(runtime, /current\.txt/);
  assert.match(launcher, /safe-restart-windows\.ps1/);
  assert.match(launcher, /Invoke-Updater 'Install'/);
});
