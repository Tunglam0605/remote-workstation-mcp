$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$helper = Join-Path $repoRoot 'scripts\windows-recovery-state.ps1'
if (-not (Test-Path -LiteralPath $helper)) { throw "Recovery-state helper missing: $helper" }

$tempBase = Join-Path ([IO.Path]::GetTempPath()) ("rwmcp-recovery-state-test-" + [Guid]::NewGuid().ToString('N'))
$savedLocalAppData = $env:LOCALAPPDATA
$env:LOCALAPPDATA = $tempBase
try {
  . $helper
  $start = Set-RwmcpDesiredState -DesiredRunning $true -Mode OpenAI -Reason 'test-start'
  if (-not $start.desiredRunning -or $start.mode -ne 'OpenAI') { throw 'Desired running state was not persisted.' }
  $maint = Set-RwmcpRecoveryMaintenance -Seconds 30 -Reason 'test-maintenance'
  if (-not $maint.maintenanceUntil) { throw 'Maintenance deadline was not persisted.' }
  $read = Get-RwmcpDesiredState
  if (-not $read.desiredRunning -or -not $read.maintenanceUntil) { throw 'Desired state did not round-trip.' }
  $stop = Set-RwmcpDesiredState -DesiredRunning $false -Mode OpenAI -Reason 'test-stop'
  if ($stop.desiredRunning) { throw 'Manual stop state did not persist.' }
  $cleared = Clear-RwmcpRecoveryMaintenance -Reason 'test-clear'
  if ($cleared.maintenanceUntil) { throw 'Maintenance deadline did not clear.' }
  Write-Host 'Autonomous recovery desired-state test passed.' -ForegroundColor Green
} finally {
  Remove-Item -LiteralPath $tempBase -Recurse -Force -ErrorAction SilentlyContinue
  $env:LOCALAPPDATA = $savedLocalAppData
}
