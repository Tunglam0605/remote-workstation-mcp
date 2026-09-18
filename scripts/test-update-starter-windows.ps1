param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$starter = Join-Path $repoRoot 'scripts\start-update-handoff-windows.ps1'
if (-not (Test-Path -LiteralPath $starter)) { throw "Starter script is missing: $starter" }

$tempBase = Join-Path ([IO.Path]::GetTempPath()) ("rwmcp-update-starter-test-" + [Guid]::NewGuid().ToString('N'))
$binDir = Join-Path $tempBase 'bin'
$runtimeDir = Join-Path $tempBase 'runtime'
$versionsDir = Join-Path $tempBase 'versions'
$fromRoot = Join-Path $versionsDir 'v0.10.0'
$toRoot = Join-Path $versionsDir 'v0.10.1'
$currentFile = Join-Path $tempBase 'current.txt'
$launcher = Join-Path $binDir 'rwmcp.ps1'
$transactionPath = Join-Path $runtimeDir 'update-transaction.json'
$workerPid = 0

function Write-Utf8NoBom([string]$Path, [string]$Content) {
  [IO.File]::WriteAllText($Path, $Content, (New-Object Text.UTF8Encoding($false)))
}

function Write-Version([string]$Root, [string]$Version) {
  New-Item -ItemType Directory -Force -Path $Root | Out-Null
  Write-Utf8NoBom (Join-Path $Root 'package.json') ('{"version":"' + $Version + '"}')
}

try {
  New-Item -ItemType Directory -Force -Path $binDir, $runtimeDir, $versionsDir | Out-Null
  Write-Version $fromRoot '0.10.0'
  Write-Version $toRoot '0.10.1'
  Write-Utf8NoBom $currentFile $fromRoot

  $launcherBody = @'
param([string]$Action)
$ErrorActionPreference = 'Stop'
$Base = Split-Path -Parent $PSScriptRoot
if ($Action -eq 'Update') {
  Start-Sleep -Seconds 2
  $target = Join-Path $Base 'versions\v0.10.1'
  [IO.File]::WriteAllText((Join-Path $Base 'current.txt'), $target, (New-Object Text.UTF8Encoding($false)))
  exit 0
}
if ($Action -eq 'StartOpenAI') { exit 0 }
exit 0
'@
  Write-Utf8NoBom $launcher $launcherBody

  $starting = [ordered]@{
    version = 1
    state = 'STARTING'
    workerPid = $null
    expectedVersion = '0.10.1'
    startedAt = [DateTimeOffset]::UtcNow.ToString('o')
    updatedAt = [DateTimeOffset]::UtcNow.ToString('o')
  } | ConvertTo-Json -Depth 4
  Write-Utf8NoBom $transactionPath ($starting + [Environment]::NewLine)

  $powershell = (Get-Command powershell.exe -ErrorAction Stop).Source
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $powershell
  $psi.Arguments = '-NoLogo -NoProfile -ExecutionPolicy Bypass -File "' + $starter + '" -RepoRoot "' + $repoRoot + '" -Base "' + $tempBase + '" -ExpectedVersion 0.10.1 -AckTimeoutSeconds 10'
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true

  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $psi
  try {
    [void]$process.Start()
    $starterPid = [int]$process.Id
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    $stdout = $stdoutTask.GetAwaiter().GetResult().Trim()
    $stderr = $stderrTask.GetAwaiter().GetResult().Trim()
    if ([int]$process.ExitCode -ne 0) {
      throw "Starter exited with code $($process.ExitCode). STDOUT=$stdout STDERR=$stderr"
    }
  } finally {
    $process.Dispose()
  }

  $result = $stdout | ConvertFrom-Json
  if ($result.acknowledged -ne $true) { throw 'Starter did not return acknowledged=true.' }
  $workerPid = [int]$result.workerPid
  if ($workerPid -le 0) { throw 'Starter did not return a valid workerPid.' }

  $worker = Get-CimInstance Win32_Process -Filter "ProcessId=$workerPid" -ErrorAction SilentlyContinue
  if ($null -ne $worker) {
    if ([int]$worker.ParentProcessId -eq $starterPid) {
      throw "Durable worker PID $workerPid is still parented to starter PID $starterPid."
    }
    if ([int]$worker.ParentProcessId -eq $PID) {
      throw "Durable worker PID $workerPid is still parented to the test process PID $PID."
    }
  }

  $deadline = [DateTimeOffset]::UtcNow.AddSeconds(20)
  $terminal = $null
  while ([DateTimeOffset]::UtcNow -lt $deadline) {
    if (Test-Path -LiteralPath $transactionPath) {
      try {
        $terminal = Get-Content -LiteralPath $transactionPath -Raw | ConvertFrom-Json
        if ([string]$terminal.state -in @('SUCCEEDED', 'FAILED')) { break }
      } catch {}
    }
    Start-Sleep -Milliseconds 200
  }

  if ($null -eq $terminal) { throw 'Update transaction was never readable.' }
  if ([string]$terminal.state -ne 'SUCCEEDED') {
    throw "Expected SUCCEEDED transaction, got '$($terminal.state)': $($terminal.message)"
  }
  if ([string]$terminal.fromVersion -ne '0.10.0') { throw "Unexpected fromVersion '$($terminal.fromVersion)'." }
  if ([string]$terminal.toVersion -ne '0.10.1') { throw "Unexpected toVersion '$($terminal.toVersion)'." }
  if ([int]$terminal.workerPid -ne $workerPid) { throw 'Transaction workerPid does not match CIM-created worker PID.' }

  Write-Host "Windows CIM durable update starter success path passed (worker PID $workerPid)." -ForegroundColor Green

  # Negative path: a CIM-created worker that exits before writing RUNNING must never
  # be reported as acknowledged/successful by the starter.
  $failureRepo = Join-Path $tempBase 'failure-repo'
  $failureScripts = Join-Path $failureRepo 'scripts'
  $failureBase = Join-Path $tempBase 'failure-base'
  $failureRuntime = Join-Path $failureBase 'runtime'
  New-Item -ItemType Directory -Force -Path $failureScripts, $failureRuntime | Out-Null
  Write-Utf8NoBom (Join-Path $failureScripts 'update-handoff-windows.ps1') "exit 7"
  $failureStarting = [ordered]@{
    version = 1
    state = 'STARTING'
    workerPid = $null
    expectedVersion = '0.10.1'
    startedAt = [DateTimeOffset]::UtcNow.ToString('o')
    updatedAt = [DateTimeOffset]::UtcNow.ToString('o')
  } | ConvertTo-Json -Depth 4
  Write-Utf8NoBom (Join-Path $failureRuntime 'update-transaction.json') ($failureStarting + [Environment]::NewLine)

  $failurePsi = New-Object System.Diagnostics.ProcessStartInfo
  $failurePsi.FileName = $powershell
  $failurePsi.Arguments = '-NoLogo -NoProfile -ExecutionPolicy Bypass -File "' + $starter + '" -RepoRoot "' + $failureRepo + '" -Base "' + $failureBase + '" -ExpectedVersion 0.10.1 -AckTimeoutSeconds 3'
  $failurePsi.UseShellExecute = $false
  $failurePsi.CreateNoWindow = $true
  $failurePsi.RedirectStandardOutput = $true
  $failurePsi.RedirectStandardError = $true
  $failureProcess = New-Object System.Diagnostics.Process
  $failureProcess.StartInfo = $failurePsi
  try {
    [void]$failureProcess.Start()
    $failureOutTask = $failureProcess.StandardOutput.ReadToEndAsync()
    $failureErrTask = $failureProcess.StandardError.ReadToEndAsync()
    $failureProcess.WaitForExit()
    $failureStdout = $failureOutTask.GetAwaiter().GetResult().Trim()
    $failureStderr = $failureErrTask.GetAwaiter().GetResult().Trim()
    if ([int]$failureProcess.ExitCode -eq 0) {
      throw "Starter falsely acknowledged an update worker that exited immediately. STDOUT=$failureStdout STDERR=$failureStderr"
    }
  } finally {
    $failureProcess.Dispose()
  }

  Write-Host 'Windows CIM durable update starter early-exit path passed.' -ForegroundColor Green

  # Timeout path: a worker that stays alive but never acknowledges must be killed by
  # the starter before it reports failure, otherwise an orphan update could proceed later.
  $timeoutRepo = Join-Path $tempBase 'timeout-repo'
  $timeoutScripts = Join-Path $timeoutRepo 'scripts'
  $timeoutBase = Join-Path $tempBase 'timeout-base'
  $timeoutRuntime = Join-Path $timeoutBase 'runtime'
  New-Item -ItemType Directory -Force -Path $timeoutScripts, $timeoutRuntime | Out-Null
  Write-Utf8NoBom (Join-Path $timeoutScripts 'update-handoff-windows.ps1') 'Start-Sleep -Seconds 10'
  $timeoutStarting = [ordered]@{
    version = 1
    state = 'STARTING'
    workerPid = $null
    expectedVersion = '0.10.1'
    startedAt = [DateTimeOffset]::UtcNow.ToString('o')
    updatedAt = [DateTimeOffset]::UtcNow.ToString('o')
  } | ConvertTo-Json -Depth 4
  Write-Utf8NoBom (Join-Path $timeoutRuntime 'update-transaction.json') ($timeoutStarting + [Environment]::NewLine)

  $timeoutPsi = New-Object System.Diagnostics.ProcessStartInfo
  $timeoutPsi.FileName = $powershell
  $timeoutPsi.Arguments = '-NoLogo -NoProfile -ExecutionPolicy Bypass -File "' + $starter + '" -RepoRoot "' + $timeoutRepo + '" -Base "' + $timeoutBase + '" -ExpectedVersion 0.10.1 -AckTimeoutSeconds 1'
  $timeoutPsi.UseShellExecute = $false
  $timeoutPsi.CreateNoWindow = $true
  $timeoutPsi.RedirectStandardOutput = $true
  $timeoutPsi.RedirectStandardError = $true
  $timeoutProcess = New-Object System.Diagnostics.Process
  $timeoutProcess.StartInfo = $timeoutPsi
  try {
    [void]$timeoutProcess.Start()
    $timeoutOutTask = $timeoutProcess.StandardOutput.ReadToEndAsync()
    $timeoutErrTask = $timeoutProcess.StandardError.ReadToEndAsync()
    $timeoutProcess.WaitForExit()
    $timeoutStdout = $timeoutOutTask.GetAwaiter().GetResult().Trim()
    $timeoutStderr = $timeoutErrTask.GetAwaiter().GetResult().Trim()
    if ([int]$timeoutProcess.ExitCode -eq 0) {
      throw "Starter falsely acknowledged a worker that never wrote RUNNING. STDOUT=$timeoutStdout STDERR=$timeoutStderr"
    }
    $combinedTimeoutOutput = $timeoutStdout + [Environment]::NewLine + $timeoutStderr
    $pidMatch = [regex]::Match($combinedTimeoutOutput, 'worker PID ([0-9]+) did not acknowledge')
    if (-not $pidMatch.Success) {
      throw "Starter timeout failure did not report the worker PID. Output=$combinedTimeoutOutput"
    }
    $timedOutWorkerPid = [int]$pidMatch.Groups[1].Value
    Start-Sleep -Milliseconds 200
    if (Get-Process -Id $timedOutWorkerPid -ErrorAction SilentlyContinue) {
      throw "Timed-out durable worker PID $timedOutWorkerPid survived starter failure."
    }
  } finally {
    $timeoutProcess.Dispose()
  }

  Write-Host 'Windows CIM durable update starter timeout-cleanup path passed.' -ForegroundColor Green
} finally {
  if ($workerPid -gt 0) {
    Stop-Process -Id $workerPid -Force -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath $tempBase -Recurse -Force -ErrorAction SilentlyContinue
}
