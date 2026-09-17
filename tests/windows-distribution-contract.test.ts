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
  assert.match(updater, /automaticPolicy = 'patch'/);
  assert.match(updater, /function Test-PatchUpgrade/);
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
  assert.match(updater, /\$Action -eq 'InstallAuto'/);
  assert.match(updater, /automatic policy installs patch releases only/);
  assert.match(updater, /Owner approval is required/);
});

test('Windows Boot starts the recovery Control Center before updater or runtime activation', async () => {
  const launcher = await read('scripts/rwmcp-launcher-windows.ps1');

  assert.match(launcher, /function Start-RecoveryControlCenter/);
  assert.match(launcher, /function Get-RecoveryRoot/);
  const bootStart = launcher.indexOf("function Invoke-SafeBoot");
  const controlStart = launcher.indexOf("Start-RecoveryControlCenter", bootStart);
  const updateStart = launcher.indexOf("Invoke-Updater 'InstallAuto'", bootStart);
  const runtimeStart = launcher.indexOf("Invoke-Runtime 'Start' 'OpenAI'", bootStart);
  assert.ok(controlStart > bootStart, 'Boot must start Control Center inside Invoke-SafeBoot.');
  assert.ok(controlStart < updateStart, 'Control Center must start before automatic update.');
  assert.ok(controlStart < runtimeStart, 'Control Center must start before OpenAI runtime activation.');
});

test('Windows Control Center host restarts its WebUI child with bounded watchdog backoff', async () => {
  const host = await read('scripts/control-center-host-windows.ps1');
  const ci = await read('.github/workflows/ci.yml');

  assert.match(host, /webRestartDelaysSeconds\s*=\s*@\(1, 2, 5, 10, 30\)/);
  assert.match(host, /while \(\$true\)/);
  assert.match(host, /Control Center child exited/);
  assert.match(host, /watchdog restart in/);
  assert.match(ci, /test-control-center-watchdog-windows\.ps1/);
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
  assert.match(setupServer, /json\(res, 202, await scheduleWindowsRuntimeRestart/);
  assert.match(host, /watchdog restart in/);
  assert.match(host, /restartDelaysSeconds = @\(1, 2, 5, 10, 30\)/);
  assert.match(host, /tunnel-readiness-lost/);
  assert.match(host, /connection-state\.json/);
  assert.match(runtime, /connectionState = \$connectionState/);
  assert.match(runtime, /'OFFLINE'/);
  assert.match(runtime, /'RECONNECTING'/);
  assert.match(runtime, /'ONLINE'/);
});
test('Windows tunnel readiness requires fresh control-plane polling, not only local readyz', async () => {
  const runtime = await read('scripts/runtime-control-windows.ps1');
  const host = await read('scripts/runtime-host-windows.ps1');
  const helper = await read('scripts/lib/tunnel-health-windows.ps1');
  const ci = await read('.github/workflows/ci.yml');

  assert.match(helper, /commands_poll_last_successful_timestamp_seconds/);
  assert.match(helper, /MaxPollAgeSeconds/);
  assert.match(helper, /poll-stale/);
  assert.match(helper, /waiting-for-first-successful-poll/);
  assert.match(runtime, /tunnel-health-windows\.ps1/);
  assert.match(runtime, /Test-RwmcpTunnelConnected/);
  assert.match(host, /tunnel-health-windows\.ps1/);
  assert.match(host, /control-plane-poll-stale/);
  assert.match(ci, /test-tunnel-health-windows\.ps1/);
});

test('Windows update install is handed off to a durable worker and activation waits beyond the watchdog recycle window', async () => {
  const setupServer = await read('src/setup/setup-server.ts');
  const worker = await read('scripts/update-handoff-windows.ps1');
  const runtime = await read('scripts/runtime-control-windows.ps1');
  const host = await read('scripts/runtime-host-windows.ps1');
  const ci = await read('.github/workflows/ci.yml');

  assert.match(setupServer, /scheduleWindowsUpdateInstall/);
  assert.match(setupServer, /update-handoff-windows\.ps1/);
  assert.match(setupServer, /detached:\s*true/);
  assert.match(setupServer, /child\.unref\(\)/);
  assert.match(setupServer, /accepted \? 202 : 200/);
  assert.match(worker, /update-transaction\.json/);
  assert.match(worker, /RemoteWorkstationMCP\.UpdateHandoff/);
  assert.match(worker, /System\.Diagnostics\.ProcessStartInfo/);
  assert.match(worker, /Invoke-LauncherAction 'Update'/);
  assert.match(worker, /RedirectStandardOutput = \$true/);
  assert.match(worker, /RedirectStandardError = \$true/);
  assert.match(worker, /WaitForExit\(\)/);
  assert.match(worker, /process\.ExitCode/);
  assert.match(worker, /StartOpenAI/);
  assert.match(worker, /SUCCEEDED/);
  assert.match(worker, /FAILED/);
  assert.match(runtime, /TunnelStartupTimeoutSeconds\s*=\s*180/);
  assert.match(host, /InitialControlPlaneGraceSeconds\s*=\s*60/);
  assert.match(host, /PostReadyFailureGraceSeconds\s*=\s*15/);
  assert.match(ci, /test-update-handoff-windows\.ps1/);
});



test('Windows restart handoff is durable, observable, and self-recovers after restart failure', async () => {
  const setupServer = await read('src/setup/setup-server.ts');
  const worker = await read('scripts/runtime-restart-handoff-windows.ps1');
  const ci = await read('.github/workflows/ci.yml');

  assert.match(setupServer, /restart-transaction\.json/);
  assert.match(setupServer, /await scheduleWindowsRuntimeRestart/);
  assert.match(setupServer, /waitForWindowsRestartWorker/);
  assert.match(worker, /RemoteWorkstationMCP\.RestartHandoff/);
  assert.match(worker, /restart-transaction\.json/);
  assert.match(worker, /restart-worker\.log/);
  assert.match(worker, /Write-Transaction 'RUNNING'/);
  assert.match(worker, /Invoke-RuntimeAction 'Restart'/);
  assert.match(worker, /Invoke-RuntimeAction 'Start'/);
  assert.match(worker, /recovery/);
  assert.match(ci, /test-restart-handoff-windows\.ps1/);
});


test('Windows autonomous recovery persists desired state and maintenance outside version slots', async () => {
  const helper = await read('scripts/windows-recovery-state.ps1');
  const runtime = await read('scripts/runtime-control-windows.ps1');
  const launcher = await read('scripts/rwmcp-launcher-windows.ps1');
  const host = await read('scripts/control-center-host-windows.ps1');
  const recovery = await read('scripts/autonomous-recovery-windows.ps1');
  const ci = await read('.github/workflows/ci.yml');

  assert.match(helper, /desired-state\.json/);
  assert.match(helper, /Set-RwmcpDesiredState/);
  assert.match(helper, /Set-RwmcpRecoveryMaintenance/);
  assert.match(helper, /Clear-RwmcpRecoveryMaintenance/);
  assert.match(helper, /Text\.UTF8Encoding\(\$false\)/);
  assert.match(runtime, /windows-recovery-state\.ps1/);
  assert.match(runtime, /RWMCP_RECOVERY_PRESERVE_DESIRED/);
  assert.match(launcher, /Set-RwmcpRecoveryMaintenance/);
  assert.match(host, /autonomous-recovery-windows\.ps1/);
  assert.match(host, /recoveryRestartDelaysSeconds\s*=\s*@\(2, 4, 8, 15, 30, 60\)/);
  assert.match(recovery, /desiredRunning/);
  assert.match(recovery, /maintenanceUntil|Test-RwmcpRecoveryMaintenanceActive/);
  assert.match(recovery, /StartOpenAI/);
  assert.match(recovery, /mcp-health-stale/);
  assert.match(recovery, /tunnel-stale/);
  assert.match(ci, /test-autonomous-recovery-state-windows\.ps1/);
  assert.match(ci, /test-autonomous-recovery-windows\.ps1/);
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

test('Windows managed install exposes a stable rwmcp-tui command on the user PATH', async () => {
  const installer = await read('scripts/install-windows-release.ps1');
  assert.match(installer, /Install-TuiLauncher/);
  assert.match(installer, /rwmcp-tui\.ps1/);
  assert.match(installer, /rwmcp-tui\.cmd/);
  assert.match(installer, /SetEnvironmentVariable\('Path'.*'User'\)/s);
  assert.match(installer, /dist\\tui-cli\.js/);
});
