param(
  [ValidateSet('All','Success','Failure')]
  [string]$Mode = 'All'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$handoff = Join-Path $repoRoot 'scripts\runtime-restart-handoff-windows.ps1'
$tempBase = Join-Path ([IO.Path]::GetTempPath()) ("rwmcp-restart-handoff-test-" + [Guid]::NewGuid().ToString('N'))
$root = Join-Path $tempBase 'versions\vtest'
$scriptsDir = Join-Path $root 'scripts'
$runtimeDir = Join-Path $tempBase 'runtime'
$runtimeControl = Join-Path $scriptsDir 'runtime-control-windows.ps1'
$transaction = Join-Path $runtimeDir 'restart-transaction.json'
$recoveryMarker = Join-Path $runtimeDir 'recovery.txt'

function Write-Utf8NoBom([string]$Path, [string]$Content) {
  [IO.File]::WriteAllText($Path, $Content, (New-Object Text.UTF8Encoding($false)))
}

function Invoke-Worker {
  $powershell = Get-Command powershell.exe -ErrorAction Stop
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $powershell.Source
  $psi.Arguments = "-NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$handoff`" -Root `"$root`" -Base `"$tempBase`" -Mode OpenAI -DelayMs 100"
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $psi
  try {
    [void]$process.Start()
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    return [pscustomobject]@{ exitCode = [int]$process.ExitCode; stdout = $stdoutTask.GetAwaiter().GetResult(); stderr = $stderrTask.GetAwaiter().GetResult() }
  } finally { $process.Dispose() }
}

try {
  New-Item -ItemType Directory -Force -Path $scriptsDir, $runtimeDir | Out-Null
  $successControl = @'
param([string]$Action,[string]$Mode,[string]$Root)
if ($Action -eq 'Restart') { exit 0 }
if ($Action -eq 'Start') { exit 0 }
exit 0
'@
  Write-Utf8NoBom $runtimeControl $successControl

  if ($Mode -in @('All','Success')) {
    $result = Invoke-Worker
    if ($result.exitCode -ne 0) { throw "Success worker exited $($result.exitCode): $($result.stderr)" }
    $tx = Get-Content -LiteralPath $transaction -Raw | ConvertFrom-Json
    if ([string]$tx.state -ne 'SUCCEEDED') { throw "Expected SUCCEEDED, got '$($tx.state)'." }
  }

  $failureControl = @'
param([string]$Action,[string]$Mode,[string]$Root)
if ($Action -eq 'Restart') { exit 7 }
if ($Action -eq 'Start') {
  $base = Split-Path -Parent (Split-Path -Parent $Root)
  $runtime = Join-Path $base 'runtime'
  New-Item -ItemType Directory -Force -Path $runtime | Out-Null
  [IO.File]::WriteAllText((Join-Path $runtime 'recovery.txt'), 'recovered', (New-Object Text.UTF8Encoding($false)))
  exit 0
}
exit 0
'@
  Write-Utf8NoBom $runtimeControl $failureControl

  if ($Mode -in @('All','Failure')) {
    $result = Invoke-Worker
    if ($result.exitCode -eq 0) { throw 'Failure worker unexpectedly succeeded.' }
    $tx = Get-Content -LiteralPath $transaction -Raw | ConvertFrom-Json
    if ([string]$tx.state -ne 'FAILED') { throw "Expected FAILED, got '$($tx.state)'." }
    if ([string]$tx.recovery -ne 'start-ok') { throw "Expected start-ok recovery, got '$($tx.recovery)'." }
    if (-not (Test-Path -LiteralPath $recoveryMarker)) { throw 'Recovery marker was not created.' }
  }
  Write-Host "Windows durable restart handoff test mode '$Mode' passed." -ForegroundColor Green
} finally {
  Remove-Item -LiteralPath $tempBase -Recurse -Force -ErrorAction SilentlyContinue
}
