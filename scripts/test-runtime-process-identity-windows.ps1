param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$runtimeControl = Join-Path $repoRoot 'scripts\runtime-control-windows.ps1'
$runtimeHost = Join-Path $repoRoot 'scripts\runtime-host-windows.ps1'
if (-not (Test-Path -LiteralPath $runtimeControl)) { throw "Runtime control script is missing: $runtimeControl" }
if (-not (Test-Path -LiteralPath $runtimeHost)) { throw "Runtime host script is missing: $runtimeHost" }

$tempBase = Join-Path ([IO.Path]::GetTempPath()) ("rwmcp-runtime-identity-" + [Guid]::NewGuid().ToString('N'))
$previousLocalAppData = $env:LOCALAPPDATA

try {
  $env:LOCALAPPDATA = $tempBase
  $stateDir = Join-Path $tempBase 'RemoteWorkstationMCP\runtime'
  $statePath = Join-Path $stateDir 'supervisor.json'
  New-Item -ItemType Directory -Force -Path $stateDir | Out-Null

  $current = Get-Process -Id $PID -ErrorAction Stop
  $state = [ordered]@{
    version = 1
    pid = $PID
    mode = 'Local'
    root = $repoRoot
    entrypoint = $runtimeHost
    processPath = [string]$current.Path
    port = 18767
    startedAt = $current.StartTime.ToUniversalTime().ToString('o')
  }
  $state | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8

  # This state intentionally reuses a live PowerShell PID/path/start time but
  # points at runtime-host-windows.ps1 even though the process command line is
  # this test script. A PID/path/time-only identity check would misclassify the
  # current test shell as the managed supervisor and reject the child Stop as a
  # self-kill. The command-line-bound identity check must fail closed instead.
  $output = & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $runtimeControl -Action Stop -Mode Local -Root $repoRoot -Json
  if ($LASTEXITCODE -ne 0) {
    throw "Synthetic PID-reuse Stop failed with exit code $LASTEXITCODE.`n$($output | Out-String)"
  }
  if (Test-Path -LiteralPath $statePath) {
    throw 'Synthetic stale supervisor state was not removed by Stop.'
  }

  $stillAlive = Get-Process -Id $PID -ErrorAction SilentlyContinue
  if (-not $stillAlive) {
    throw 'Runtime identity smoke test unexpectedly terminated its own caller.'
  }

  Write-Host 'Windows runtime process identity PID-reuse regression test passed.' -ForegroundColor Green
} finally {
  if ($null -eq $previousLocalAppData) {
    Remove-Item Env:LOCALAPPDATA -ErrorAction SilentlyContinue
  } else {
    $env:LOCALAPPDATA = $previousLocalAppData
  }
  Remove-Item -LiteralPath $tempBase -Recurse -Force -ErrorAction SilentlyContinue
}
