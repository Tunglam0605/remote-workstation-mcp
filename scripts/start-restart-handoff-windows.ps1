param(
  [Parameter(Mandatory = $true)]
  [string]$Root,
  [Parameter(Mandatory = $true)]
  [string]$Base,
  [ValidateSet('Local','OpenAI')]
  [string]$Mode = 'OpenAI',
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

$Root = [IO.Path]::GetFullPath($Root)
$Base = [IO.Path]::GetFullPath($Base)
Assert-SafeCommandArg $Root 'Root'
Assert-SafeCommandArg $Base 'Base'

$worker = [IO.Path]::GetFullPath((Join-Path $Root 'scripts\runtime-restart-handoff-windows.ps1'))
if (-not (Test-Path -LiteralPath $worker)) {
  throw "Windows restart handoff helper is missing: $worker"
}
Assert-SafeCommandArg $worker 'worker path'

$runtimeDir = Join-Path $Base 'runtime'
$transactionPath = Join-Path $runtimeDir 'restart-transaction.json'
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
  '-Root', (Quote-CommandArg $Root),
  '-Mode', $Mode,
  '-Base', (Quote-CommandArg $Base)
)
$commandLine = $parts -join ' '

# Win32_Process.Create intentionally detaches the durable worker from both the
# MCP runtime tree and the persistent Control Center tree. The worker can then
# stop/restart the managed runtime without killing the process that owns the handoff.
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
      # Worker atomically replaces the transaction file. Retry narrow read races.
    }
  }

  if (-not (Get-Process -Id $workerPid -ErrorAction SilentlyContinue)) {
    throw "Durable restart worker PID $workerPid exited before startup acknowledgement."
  }
  Start-Sleep -Milliseconds 100
}

Stop-Process -Id $workerPid -Force -ErrorAction SilentlyContinue
throw "Durable restart worker PID $workerPid did not acknowledge startup within $AckTimeoutSeconds seconds."
