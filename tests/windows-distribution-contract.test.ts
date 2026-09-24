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
  assert.match(updater, /lastInstalledVersion = \[string\]\$latest\.version/);
  assert.match(updater, /\$state\.failedVersion = \$null/);
  assert.match(updater, /\$state\.failedAt = \$null/);
  assert.match(updater, /\$state\.retryAfter = \$null/);
  assert.match(updater, /lastNotifiedVersion/);
  assert.match(updater, /Show-UpdateDesktopNotification/);
  assert.match(updater, /show-windows-notification\.ps1/);
});

test('Windows desktop notification helper is packaged, bounded and CI-validated', async () => {
  const helper = await read('scripts/show-windows-notification.ps1');
  const ci = await read('.github/workflows/ci.yml');

  assert.match(helper, /PayloadBase64/);
  assert.match(helper, /ConvertFrom-Json/);
  assert.match(helper, /System\.Windows\.Forms\.NotifyIcon/);
  assert.match(helper, /ShowBalloonTip/);
  assert.match(helper, /DryRun/);
  assert.match(ci, /show-windows-notification\.ps1/);
  assert.match(ci, /Test Windows desktop notification helper/);
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

test('Windows slot switches re-home the recovery plane to the active slot before lifecycle success', async () => {
  const launcher = await read('scripts/rwmcp-launcher-windows.ps1');

  assert.match(launcher, /Control Center recovery verification failed for root/);
  assert.match(launcher, /managedPortOwned/);
  assert.match(launcher, /\$sameRoot/);

  const bootStart = launcher.indexOf('function Invoke-SafeBoot');
  const bootEnd = launcher.indexOf('$Root = if ($Action', bootStart);
  const boot = launcher.slice(bootStart, bootEnd);
  assert.ok(boot.indexOf('$candidate = Get-CurrentRoot') < boot.indexOf('Start-RecoveryControlCenter $candidate'));
  assert.ok(boot.indexOf('Start-RecoveryControlCenter $candidate') < boot.indexOf("Invoke-Runtime 'Start' 'OpenAI' $candidate"));
  assert.match(boot, /\$rollbackRoot = Get-CurrentRoot[\s\S]*Start-RecoveryControlCenter \$rollbackRoot[\s\S]*Invoke-Runtime 'Start' 'OpenAI' \$rollbackRoot/);

  const updateStart = launcher.indexOf("  'Update' {");
  const rollbackStart = launcher.indexOf("  'Rollback' {", updateStart);
  const update = launcher.slice(updateStart, rollbackStart);
  assert.ok(update.indexOf("Invoke-Updater 'Install'") < update.indexOf('$candidate = Get-CurrentRoot'));
  assert.ok(update.indexOf('$candidate = Get-CurrentRoot') < update.indexOf('Start-RecoveryControlCenter $candidate'));
  assert.ok(update.indexOf('Start-RecoveryControlCenter $candidate') < update.indexOf("Invoke-Runtime 'Start' 'OpenAI' $candidate"));
  assert.match(update, /\$rollbackRoot = Get-CurrentRoot[\s\S]*Start-RecoveryControlCenter \$rollbackRoot/);

  const rollback = launcher.slice(rollbackStart);
  assert.match(rollback, /-Rollback -NoSetup[\s\S]*\$rollbackRoot = Get-CurrentRoot[\s\S]*Start-RecoveryControlCenter \$rollbackRoot/);
  assert.ok(rollback.indexOf('Start-RecoveryControlCenter $rollbackRoot') < rollback.indexOf("Invoke-Runtime 'Start' 'OpenAI' $rollbackRoot"));
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
test('Windows runtime supervisor identity resists fast PowerShell PID reuse', async () => {
  const runtime = await read('scripts/runtime-control-windows.ps1');
  const regression = await read('scripts/test-runtime-process-identity-windows.ps1');
  const ci = await read('.github/workflows/ci.yml');

  assert.match(runtime, /Get-CimInstance Win32_Process -Filter "ProcessId=\$\(\[int\]\$state\.pid\)"/);
  assert.match(runtime, /state\.entrypoint/);
  assert.match(runtime, /expectedEntrypoint/);
  assert.match(runtime, /commandLine\.IndexOf\(\$expectedEntrypoint/);
  assert.match(runtime, /commandLine\.IndexOf\(\$expectedRoot/);

  assert.match(regression, /rwmcp-runtime-identity-/);
  assert.match(regression, /pid = \$PID/);
  assert.match(regression, /entrypoint = \$runtimeHost/);
  assert.match(regression, /-Action Stop/);
  assert.match(regression, /Synthetic stale supervisor state was not removed/);
  assert.match(ci, /Test Windows runtime supervisor process identity/);
  assert.match(ci, /test-runtime-process-identity-windows\.ps1/);
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
  const starter = await read('scripts/start-update-handoff-windows.ps1');
  const worker = await read('scripts/update-handoff-windows.ps1');
  const convergence = await read('scripts/windows-runtime-convergence.ps1');
  const runtime = await read('scripts/runtime-control-windows.ps1');
  const host = await read('scripts/runtime-host-windows.ps1');
  const ci = await read('.github/workflows/ci.yml');

  assert.match(setupServer, /scheduleWindowsUpdateInstall/);
  assert.match(setupServer, /update-handoff-windows\.ps1/);
  assert.match(setupServer, /start-update-handoff-windows\.ps1/);
  assert.match(setupServer, /AckTimeoutSeconds/);
  assert.match(setupServer, /acknowledged/);
  assert.match(setupServer, /accepted \? 202 : 200/);
  assert.match(worker, /update-transaction\.json/);
  assert.match(worker, /RemoteWorkstationMCP\.UpdateHandoff/);
  assert.match(runtime, /windows-runtime-convergence\.ps1/);
  assert.match(convergence, /openai-tunnel-cli\.js/);
  assert.match(convergence, /dist\\cli\.js/);

  const updateSchedule = setupServer.slice(
    setupServer.indexOf('async function scheduleWindowsUpdateInstall'),
    setupServer.indexOf('async function windowsUpdateControl')
  );
  assert.ok(
    updateSchedule.indexOf("state: 'STARTING'") < updateSchedule.indexOf("await runProcess('powershell.exe'"),
    'STARTING must be persisted before executing the durable Windows update starter'
  );
  assert.doesNotMatch(updateSchedule, /detached:\s*true/);
  assert.doesNotMatch(updateSchedule, /child\.unref\(\)/);
  assert.match(updateSchedule, /readWindowsUpdateTransaction[\s\S]*RUNNING[\s\S]*SUCCEEDED/);
  assert.match(setupServer, /starter-never-acknowledged/);

  assert.match(starter, /Invoke-CimMethod[\s\S]*Win32_Process[\s\S]*Create/);
  assert.match(starter, /acknowledged/);
  assert.match(starter, /Get-Process -Id \$workerPid/);
  assert.match(starter, /Stop-Process -Id \$workerPid -Force/);
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
  assert.match(ci, /test-update-starter-windows\.ps1/);
});



test('Windows restart handoff is durable, observable, and self-recovers after restart failure', async () => {
  const setupServer = await read('src/setup/setup-server.ts');
  const starter = await read('scripts/start-restart-handoff-windows.ps1');
  const worker = await read('scripts/runtime-restart-handoff-windows.ps1');
  const ci = await read('.github/workflows/ci.yml');

  assert.match(setupServer, /restart-transaction\.json/);
  assert.match(setupServer, /await scheduleWindowsRuntimeRestart/);
  assert.match(setupServer, /start-restart-handoff-windows\.ps1/);
  assert.match(setupServer, /AckTimeoutSeconds/);
  assert.match(setupServer, /acknowledged/);

  const restartSchedule = setupServer.slice(
    setupServer.indexOf('async function scheduleWindowsRuntimeRestart'),
    setupServer.indexOf('type UpdateAction')
  );
  assert.ok(
    restartSchedule.indexOf("state: 'STARTING'") < restartSchedule.indexOf("await runProcess('powershell.exe'"),
    'STARTING must be persisted before executing the durable Windows restart starter'
  );
  assert.doesNotMatch(restartSchedule, /detached:\s*true/);
  assert.doesNotMatch(restartSchedule, /child\.unref\(\)/);
  assert.match(restartSchedule, /readWindowsRestartTransaction[\s\S]*RUNNING[\s\S]*SUCCEEDED/);

  assert.match(starter, /Invoke-CimMethod[\s\S]*Win32_Process[\s\S]*Create/);
  assert.match(starter, /acknowledged/);
  assert.match(starter, /Get-Process -Id \$workerPid/);
  assert.match(starter, /Stop-Process -Id \$workerPid -Force/);

  assert.match(worker, /RemoteWorkstationMCP\.RestartHandoff/);
  assert.match(worker, /restart-transaction\.json/);
  assert.match(worker, /restart-worker\.log/);
  assert.match(worker, /Write-Transaction 'RUNNING'/);
  assert.match(worker, /Invoke-RuntimeAction 'Restart'/);
  assert.match(worker, /Invoke-RuntimeAction 'Start'/);
  assert.match(worker, /recovery/);
  assert.match(ci, /test-restart-handoff-windows\.ps1/);
  assert.match(ci, /test-restart-starter-windows\.ps1/);
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
  assert.match(host, /windows-runtime-convergence\.ps1/);
  assert.match(host, /Invoke-RwmcpRecoveryPlaneConvergence/);
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

test('Windows autonomous recovery watchdog requires a fresh heartbeat and restarts a hung recovery worker', async () => {
  const host = await read('scripts/control-center-host-windows.ps1');
  const recovery = await read('scripts/autonomous-recovery-windows.ps1');
  assert.match(host, /recovery-supervisor-state\.json/);
  assert.match(host, /RecoveryHeartbeatStartupGraceSeconds/);
  assert.match(host, /RecoveryHeartbeatStaleSeconds/);
  assert.match(host, /heartbeat.*stale|stale.*heartbeat/i);
  assert.match(host, /Stop-Process.*recoveryChild\.Id/i);
  assert.match(recovery, /recovery-supervisor-state\.json/);
  assert.match(recovery, /updatedAt/);
  assert.match(recovery, /Write-RecoveryHeartbeat/);
  assert.match(recovery, /current\.txt/);
  assert.match(recovery, /Test-CurrentSlotOwnership/);
  assert.match(recovery, /stale-slot-exit/);
});


test('Windows runtime start is serialized across processes before spawning a supervisor', async () => {
  const runtime = await read('scripts/runtime-control-windows.ps1');
  const ci = await read('.github/workflows/ci.yml');
  assert.match(runtime, /runtime-start\.lock/);
  assert.match(runtime, /FileShare\]::None|FileShare\.None/);
  assert.match(runtime, /Acquire-RuntimeStartLock/);
  assert.match(runtime, /Release-RuntimeStartLock/);
  assert.match(runtime, /Start-Runtime/);
  assert.match(ci, /test-runtime-start-concurrency-windows\.ps1/);
});

test('Windows lifecycle transactions persist monotonic epochs and suppress recovery only for a live owner', async () => {
  const helper = await read('scripts/windows-lifecycle-state.ps1');
  const runtime = await read('scripts/runtime-control-windows.ps1');
  const launcher = await read('scripts/rwmcp-launcher-windows.ps1');
  assert.match(helper, /lifecycle-state\.json/);
  assert.match(helper, /Begin-RwmcpLifecycleTransaction/);
  assert.match(helper, /Complete-RwmcpLifecycleTransaction/);
  assert.match(helper, /Test-RwmcpLifecycleTransactionActive/);
  assert.match(helper, /ownerPid/);
  assert.match(helper, /ownerStartedAt/);
  assert.match(helper, /epoch/);
  assert.match(helper, /Text\.UTF8Encoding\(\$false\)/);
  assert.match(runtime, /windows-lifecycle-state\.ps1/);
  assert.match(launcher, /windows-lifecycle-state\.ps1/);
});

test('Windows autonomous recovery converges stale and duplicate managed processes without racing lifecycle work', async () => {
  const recovery = await read('scripts/autonomous-recovery-windows.ps1');
  const convergence = await read('scripts/windows-runtime-convergence.ps1');
  assert.match(recovery, /windows-lifecycle-state\.ps1/);
  assert.match(recovery, /Test-RwmcpLifecycleTransactionActive/);
  assert.match(recovery, /windows-runtime-convergence\.ps1/);
  assert.match(recovery, /Invoke-RuntimeConvergence/);
  assert.match(recovery, /suppressed-lifecycle/);
  assert.match(convergence, /runtime-host-windows\.ps1/);
  assert.match(convergence, /openai-tunnel-cli\.js/);
  assert.match(convergence, /dist\\cli\.js/);
  assert.match(convergence, /tunnel-client\.exe/);
  assert.match(convergence, /Stop-RwmcpManagedProcessTree/);
  assert.match(convergence, /Stale supervisor state detected/);
  assert.match(convergence, /Invoke-RwmcpRecoveryPlaneConvergence/);
  assert.match(convergence, /autonomous-recovery-windows\.ps1/);
  assert.match(convergence, /duplicate-current-slot|stale-other-slot/);
});

test('Windows recovery circuit breaker persists cooldowns and opens after repeated failed recovery attempts', async () => {
  const helper = await read('scripts/windows-recovery-circuit.ps1');
  const recovery = await read('scripts/autonomous-recovery-windows.ps1');
  assert.match(helper, /recovery-circuit\.json/);
  assert.match(helper, /Register-RwmcpRecoveryFailure/);
  assert.match(helper, /Reset-RwmcpRecoveryCircuit/);
  assert.match(helper, /Test-RwmcpRecoveryCircuitAllowsAction/);
  assert.match(helper, /2, 4, 8, 15, 30, 60/);
  assert.match(helper, /AddMinutes\(5\)/);
  assert.match(recovery, /windows-recovery-circuit\.ps1/);
  assert.match(recovery, /Register-RwmcpRecoveryFailure/);
  assert.match(recovery, /Reset-RwmcpRecoveryCircuit/);
});

test('Windows installer repairs the OpenAI tunnel client even when the runtime slot already exists', async () => {
  const installer = await read('scripts/install-windows-release.ps1');

  const slotBranch = installer.indexOf("  if (-not (Test-Path $Slot)) {");
  const existingSlotBranch = installer.indexOf('Runtime slot already exists: $Slot', slotBranch);
  const tunnelInstaller = installer.indexOf("$tunnelInstaller = Join-Path $Slot 'scripts\\install-openai-tunnel-windows.ps1'", existingSlotBranch);
  const activateSlot = installer.indexOf('  $oldCurrent =', existingSlotBranch);

  assert.ok(slotBranch >= 0, 'runtime-slot install branch must exist');
  assert.ok(existingSlotBranch > slotBranch, 'existing-slot branch must remain explicit');
  assert.ok(tunnelInstaller > existingSlotBranch, 'tunnel-client repair must run after the existing-slot branch');
  assert.ok(tunnelInstaller < activateSlot, 'tunnel-client repair must run before the slot is activated');
  assert.match(installer, /Test-Path \$tunnelInstaller/);
  assert.match(installer, /OpenAI tunnel-client installation failed/);
});