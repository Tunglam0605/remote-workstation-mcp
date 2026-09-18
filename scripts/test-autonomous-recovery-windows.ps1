$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$worker = Join-Path $repoRoot 'scripts\autonomous-recovery-windows.ps1'
$stateHelper = Join-Path $repoRoot 'scripts\windows-recovery-state.ps1'
$tempLocal = Join-Path ([IO.Path]::GetTempPath()) ("rwmcp-autorecovery-test-" + [Guid]::NewGuid().ToString('N'))
$base = Join-Path $tempLocal 'RemoteWorkstationMCP'
$bin = Join-Path $base 'bin'
$runtime = Join-Path $base 'runtime'
$marker = Join-Path $runtime 'launcher-action.txt'
$savedLocal = $env:LOCALAPPDATA
$env:LOCALAPPDATA = $tempLocal
try {
  New-Item -ItemType Directory -Force -Path $bin, $runtime | Out-Null
  . $stateHelper
  $fakeLauncher = @'
param([string]$Action)
$base = Split-Path -Parent $PSScriptRoot
$runtime = Join-Path $base 'runtime'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
[IO.File]::WriteAllText((Join-Path $runtime 'launcher-action.txt'), $Action, (New-Object Text.UTF8Encoding($false)))
exit 0
'@
  [IO.File]::WriteAllText((Join-Path $bin 'rwmcp.ps1'), $fakeLauncher, (New-Object Text.UTF8Encoding($false)))

  Set-RwmcpDesiredState -DesiredRunning $false -Mode OpenAI -Reason 'owner-stop' | Out-Null
  & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $worker -Root $repoRoot -OneShot | Out-Null
  if (Test-Path $marker) { throw 'Owner Stop must suppress autonomous recovery.' }

  Set-RwmcpDesiredState -DesiredRunning $true -Mode OpenAI -Reason 'test-start' | Out-Null
  Clear-RwmcpRecoveryMaintenance -Reason 'test-ready' | Out-Null
  & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $worker -Root $repoRoot -OneShot | Out-Null
  if (-not (Test-Path $marker)) { throw 'Missing runtime did not trigger autonomous StartOpenAI.' }
  $action = (Get-Content -LiteralPath $marker -Raw).Trim()
  if ($action -ne 'StartOpenAI') { throw "Expected StartOpenAI, got '$action'." }
  Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
  $recoveryHeartbeat = Join-Path $runtime 'recovery-supervisor-state.json'
  Remove-Item -LiteralPath $recoveryHeartbeat -Force -ErrorAction SilentlyContinue
  $otherRoot = Join-Path $base 'versions\vnext'
  New-Item -ItemType Directory -Force -Path $otherRoot | Out-Null
  [IO.File]::WriteAllText((Join-Path $base 'current.txt'), $otherRoot + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))

  $staleOutput = & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $worker -Root $repoRoot -OneShot
  $staleText = ($staleOutput -join [Environment]::NewLine)
  if ($staleText -notmatch 'stale-slot-exit') {
    throw "Old-slot autonomous recovery did not self-terminate after current.txt switched roots. Output=$staleText"
  }
  if (Test-Path -LiteralPath $marker) { throw 'Stale-slot recovery must not invoke the stable launcher.' }
  if (Test-Path -LiteralPath $recoveryHeartbeat) { throw 'Stale-slot recovery must not overwrite the shared recovery heartbeat.' }

  Write-Host 'Autonomous recovery decision and stale-slot self-termination tests passed.' -ForegroundColor Green
} finally {
  $env:LOCALAPPDATA = $savedLocal
  Remove-Item -LiteralPath $tempLocal -Recurse -Force -ErrorAction SilentlyContinue
}
