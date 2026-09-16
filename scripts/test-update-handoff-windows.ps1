param(
  [ValidateSet('All','Success','Failure','FailureExit','FailureTransaction','FailureRecovery','FailureMarker')]
  [string]$Mode = 'All'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$handoff = Join-Path $repoRoot 'scripts\update-handoff-windows.ps1'
if (-not (Test-Path -LiteralPath $handoff)) { throw "Update handoff script is missing: $handoff" }

$tempBase = Join-Path ([IO.Path]::GetTempPath()) ("rwmcp-update-handoff-test-" + [Guid]::NewGuid().ToString('N'))
$binDir = Join-Path $tempBase 'bin'
$runtimeDir = Join-Path $tempBase 'runtime'
$versionsDir = Join-Path $tempBase 'versions'
$v091 = Join-Path $versionsDir 'v0.9.1'
$v092 = Join-Path $versionsDir 'v0.9.2'
$launcher = Join-Path $binDir 'rwmcp.ps1'
$currentFile = Join-Path $tempBase 'current.txt'
$transaction = Join-Path $runtimeDir 'update-transaction.json'
$recoveryMarker = Join-Path $runtimeDir 'recovery.txt'

function Write-Utf8NoBom([string]$Path, [string]$Content) {
  [IO.File]::WriteAllText($Path, $Content, (New-Object Text.UTF8Encoding($false)))
}

function Write-Version([string]$Root, [string]$Version) {
  New-Item -ItemType Directory -Force -Path $Root | Out-Null
  Write-Utf8NoBom (Join-Path $Root 'package.json') ("{`"version`":`"$Version`"}")
}

try {
  New-Item -ItemType Directory -Force -Path $binDir, $runtimeDir, $versionsDir | Out-Null
  Write-Version $v091 '0.9.1'
  Write-Version $v092 '0.9.2'
  Write-Utf8NoBom $currentFile $v091

  $successLauncher = @'
param([string]$Action)
$ErrorActionPreference = 'Stop'
$Base = Split-Path -Parent $PSScriptRoot
if ($Action -eq 'Update') {
  $target = Join-Path $Base 'versions\v0.9.2'
  [IO.File]::WriteAllText((Join-Path $Base 'current.txt'), $target, (New-Object Text.UTF8Encoding($false)))
  exit 0
}
if ($Action -eq 'StartOpenAI') { exit 0 }
exit 0
'@
  Write-Utf8NoBom $launcher $successLauncher

  if ($Mode -in @('All','Success')) {
    & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $handoff -Base $tempBase -ExpectedVersion '0.9.2'
    if ($LASTEXITCODE -ne 0) {
      $workerLog = if (Test-Path -LiteralPath (Join-Path $runtimeDir 'update-worker.log')) { Get-Content -LiteralPath (Join-Path $runtimeDir 'update-worker.log') -Raw } else { '<no worker log>' }
      $tx = if (Test-Path -LiteralPath $transaction) { Get-Content -LiteralPath $transaction -Raw } else { '<no transaction>' }
      throw "Success-path handoff exited with code $LASTEXITCODE.`nTransaction:`n$tx`nWorker log:`n$workerLog"
    }
    if (-not (Test-Path -LiteralPath $transaction)) { throw 'Success-path transaction file was not created.' }
    $success = Get-Content -LiteralPath $transaction -Raw | ConvertFrom-Json
    if ([string]$success.state -ne 'SUCCEEDED') { throw "Expected SUCCEEDED transaction, got '$($success.state)'." }
    if ([string]$success.fromVersion -ne '0.9.1') { throw "Unexpected fromVersion '$($success.fromVersion)'." }
    if ([string]$success.toVersion -ne '0.9.2') { throw "Unexpected toVersion '$($success.toVersion)'." }
    if ([string]$success.expectedVersion -ne '0.9.2') { throw "Unexpected expectedVersion '$($success.expectedVersion)'." }
  }

  Write-Utf8NoBom $currentFile $v091
  $failureLauncher = @'
param([string]$Action)
$ErrorActionPreference = 'Stop'
$Base = Split-Path -Parent $PSScriptRoot
if ($Action -eq 'Update') { exit 7 }
if ($Action -eq 'StartOpenAI') {
  $runtime = Join-Path $Base 'runtime'
  New-Item -ItemType Directory -Force -Path $runtime | Out-Null
  [IO.File]::WriteAllText((Join-Path $runtime 'recovery.txt'), 'recovered', (New-Object Text.UTF8Encoding($false)))
  exit 0
}
exit 0
'@
  Write-Utf8NoBom $launcher $failureLauncher

  if ($Mode -in @('All','Failure','FailureExit','FailureTransaction','FailureRecovery','FailureMarker')) {
    & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $handoff -Base $tempBase -ExpectedVersion '0.9.2'
    $workerExit = $LASTEXITCODE
    if ($workerExit -eq 0) { throw 'Failure-path handoff unexpectedly succeeded.' }
    if ($Mode -eq 'FailureExit') { Write-Host 'Failure worker exit checkpoint passed.' -ForegroundColor Green; return }

    if (-not (Test-Path -LiteralPath $transaction)) { throw 'Failure-path transaction file was not created.' }
    $failure = Get-Content -LiteralPath $transaction -Raw | ConvertFrom-Json
    if ([string]$failure.state -ne 'FAILED') { throw "Expected FAILED transaction, got '$($failure.state)'." }
    if ($Mode -eq 'FailureTransaction') { Write-Host 'Failure transaction checkpoint passed.' -ForegroundColor Green; return }

    if ([string]$failure.recovery -ne 'start-openai-ok') { throw "Expected StartOpenAI recovery, got '$($failure.recovery)'." }
    if ($Mode -eq 'FailureRecovery') { Write-Host 'Failure recovery-state checkpoint passed.' -ForegroundColor Green; return }

    if (-not (Test-Path -LiteralPath $recoveryMarker)) { throw 'Recovery marker was not created.' }
    if ($Mode -eq 'FailureMarker') { Write-Host 'Failure recovery-marker checkpoint passed.' -ForegroundColor Green; return }
  }

  Write-Host "Windows durable update handoff test mode '$Mode' passed." -ForegroundColor Green
} finally {
  Remove-Item -LiteralPath $tempBase -Recurse -Force -ErrorAction SilentlyContinue
}
