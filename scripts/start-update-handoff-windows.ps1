param(
  [Parameter(Mandatory = $true)]
  [string]$RepoRoot,
  [Parameter(Mandatory = $true)]
  [string]$Base,
  [Parameter(Mandatory = $true)]
  [string]$ExpectedVersion,
  [ValidateRange(1, 30)]
  [int]$AckTimeoutSeconds = 10
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-SafeCommandArg([string]$Value, [string]$Name) {
  if ([string]::IsNullOrWhiteSpace($Value)) { throw "$Name is required." }
  if ($Value.Contains('"') -or $Value.Contains([Environment]::NewLine)) {
    throw "$Name contains unsupported command-line characters."
  }
}

function Quote-CommandArg([string]$Value) {
  Assert-SafeCommandArg $Value 'argument'
  return '"' + $Value + '"'
}

$RepoRoot = [IO.Path]::GetFullPath($RepoRoot)
$Base = [IO.Path]::GetFullPath($Base)
$ExpectedVersion = $ExpectedVersion.TrimStart('v')
if ($ExpectedVersion -notmatch '^[0-9]+[.][0-9]+[.][0-9]+(?:[-+][0-9A-Za-z.-]+)?$') {
  throw "ExpectedVersion is not a supported semantic version: $ExpectedVersion"
}
Assert-SafeCommandArg $RepoRoot 'RepoRoot'
Assert-SafeCommandArg $Base 'Base'

$worker = [IO.Path]::GetFullPath((Join-Path $RepoRoot 'scripts\update-handoff-windows.ps1'))
if (-not (Test-Path -LiteralPath $worker)) {
  throw "Windows update handoff helper is missing: $worker"
}
Assert-SafeCommandArg $worker 'worker path'

$runtimeDir = Join-Path $Base 'runtime'
$transactionPath = Join-Path $runtimeDir 'update-transaction.json'
New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null

$powershell = (Get-Command powershell.exe -ErrorAction Stop).Source
Assert-SafeCommandArg $powershell 'powershell path'

$parts = @(
  (Quote-CommandArg $powershell),
  '-NoLogo',
  '-NoProfile',
  '-NonInteractive',
  '-WindowStyle', 'Hidden',
  '-ExecutionPolicy', 'Bypass',
  '-File', (Quote-CommandArg $worker),
  '-Base', (Quote-CommandArg $Base),
  '-ExpectedVersion', (Quote-CommandArg $ExpectedVersion)
)
$commandLine = $parts -join ' '

# Win32_Process.Create is intentionally used instead of child_process.spawn(detached=true).
# CIM/WMI creates the durable worker outside the managed Control Center/runtime tree,
# so runtime convergence or restart cannot kill the handoff that owns the update.
$created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $commandLine }
if ([int]$created.ReturnValue -ne 0 -or [int]$created.ProcessId -le 0) {
  throw "Win32_Process.Create failed with return value $($created.ReturnValue)."
}
$workerPid = [int]$created.ProcessId

$deadline = [DateTimeOffset]::UtcNow.AddSeconds($AckTimeoutSeconds)
while ([DateTimeOffset]::UtcNow -lt $deadline) {
  if (Test-Path -LiteralPath $transactionPath) {
    try {
      $transaction = Get-Content -LiteralPath $transactionPath -Raw -ErrorAction Stop | ConvertFrom-Json
      $state = [string]$transaction.state
      $transactionPid = 0
      if ($null -ne $transaction.workerPid) { $transactionPid = [int]$transaction.workerPid }
      if ($state -in @('RUNNING', 'SUCCEEDED', 'FAILED') -and ($transactionPid -eq 0 -or $transactionPid -eq $workerPid)) {
        [pscustomobject]@{
          workerPid = $workerPid
          acknowledged = $true
          state = $state
        } | ConvertTo-Json -Compress
        if ($state -eq 'FAILED') { exit 4 }
        exit 0
      }
    } catch {
      # The durable worker atomically replaces the transaction file. Retry a narrow read race.
    }
  }

  if (-not (Get-Process -Id $workerPid -ErrorAction SilentlyContinue)) {
    throw "Durable update worker PID $workerPid exited before startup acknowledgement."
  }
  Start-Sleep -Milliseconds 100
}

Stop-Process -Id $workerPid -Force -ErrorAction SilentlyContinue
throw "Durable update worker PID $workerPid did not acknowledge startup within $AckTimeoutSeconds seconds."
