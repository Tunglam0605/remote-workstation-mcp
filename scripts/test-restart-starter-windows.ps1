param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$starter = Join-Path $repoRoot 'scripts\start-restart-handoff-windows.ps1'
$workerSource = Join-Path $repoRoot 'scripts\runtime-restart-handoff-windows.ps1'
if (-not (Test-Path -LiteralPath $starter)) { throw "Starter script is missing: $starter" }
if (-not (Test-Path -LiteralPath $workerSource)) { throw "Worker script is missing: $workerSource" }

$tempBase = Join-Path ([IO.Path]::GetTempPath()) ("rwmcp-restart-starter-test-" + [Guid]::NewGuid().ToString('N'))
$root = Join-Path $tempBase 'versions\vtest'
$scriptsDir = Join-Path $root 'scripts'
$runtimeDir = Join-Path $tempBase 'runtime'
$transactionPath = Join-Path $runtimeDir 'restart-transaction.json'
$workerPid = 0

function Write-Utf8NoBom([string]$Path, [string]$Content) {
  [IO.File]::WriteAllText($Path, $Content, (New-Object Text.UTF8Encoding($false)))
}

function Write-Starting([string]$Path, [string]$RootPath, [string]$Mode) {
  $payload = [ordered]@{
    version = 1
    state = 'STARTING'
    workerPid = $null
    root = $RootPath
    mode = $Mode
    startedAt = [DateTimeOffset]::UtcNow.ToString('o')
    updatedAt = [DateTimeOffset]::UtcNow.ToString('o')
  } | ConvertTo-Json -Depth 4
  Write-Utf8NoBom $Path ($payload + [Environment]::NewLine)
}

function Invoke-Starter([string]$RootPath, [string]$BasePath, [int]$TimeoutSeconds) {
  $powershell = (Get-Command powershell.exe -ErrorAction Stop).Source
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $powershell
  $psi.Arguments = '-NoLogo -NoProfile -ExecutionPolicy Bypass -File "' + $starter + '" -Root "' + $RootPath + '" -Base "' + $BasePath + '" -Mode OpenAI -AckTimeoutSeconds ' + $TimeoutSeconds
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
    return [pscustomobject]@{
      exitCode = [int]$process.ExitCode
      starterPid = $starterPid
      stdout = $stdoutTask.GetAwaiter().GetResult().Trim()
      stderr = $stderrTask.GetAwaiter().GetResult().Trim()
    }
  } finally {
    $process.Dispose()
  }
}

try {
  New-Item -ItemType Directory -Force -Path $scriptsDir, $runtimeDir | Out-Null
  Copy-Item -LiteralPath $workerSource -Destination (Join-Path $scriptsDir 'runtime-restart-handoff-windows.ps1') -Force
  $runtimeControl = @'
param([string]$Action,[string]$Mode,[string]$Root)
if ($Action -eq 'Restart') { exit 0 }
if ($Action -eq 'Start') { exit 0 }
exit 0
'@
  Write-Utf8NoBom (Join-Path $scriptsDir 'runtime-control-windows.ps1') $runtimeControl
  Write-Starting $transactionPath $root 'OpenAI'

  $result = Invoke-Starter $root $tempBase 10
  if ($result.exitCode -ne 0) {
    throw "Starter exited with code $($result.exitCode). STDOUT=$($result.stdout) STDERR=$($result.stderr)"
  }
  $ack = $result.stdout | ConvertFrom-Json
  if ($ack.acknowledged -ne $true) { throw 'Starter did not return acknowledged=true.' }
  $workerPid = [int]$ack.workerPid
  if ($workerPid -le 0) { throw 'Starter did not return a valid workerPid.' }

  $worker = Get-CimInstance Win32_Process -Filter "ProcessId=$workerPid" -ErrorAction SilentlyContinue
  if ($null -ne $worker) {
    if ([int]$worker.ParentProcessId -eq $result.starterPid) {
      throw "Durable restart worker PID $workerPid is still parented to starter PID $($result.starterPid)."
    }
    if ([int]$worker.ParentProcessId -eq $PID) {
      throw "Durable restart worker PID $workerPid is still parented to test PID $PID."
    }
  }

  $deadline = [DateTimeOffset]::UtcNow.AddSeconds(15)
  $terminal = $null
  while ([DateTimeOffset]::UtcNow -lt $deadline) {
    if (Test-Path -LiteralPath $transactionPath) {
      try {
        $terminal = Get-Content -LiteralPath $transactionPath -Raw | ConvertFrom-Json
        if ([string]$terminal.state -in @('SUCCEEDED','FAILED')) { break }
      } catch {}
    }
    Start-Sleep -Milliseconds 100
  }
  if ($null -eq $terminal -or [string]$terminal.state -ne 'SUCCEEDED') {
    throw "Expected SUCCEEDED restart transaction, got '$([string]$terminal.state)'."
  }
  if ([int]$terminal.workerPid -ne $workerPid) { throw 'Transaction workerPid does not match CIM-created worker PID.' }
  Write-Host "Windows CIM durable restart starter success path passed (worker PID $workerPid)." -ForegroundColor Green

  $failureRoot = Join-Path $tempBase 'failure\vtest'
  $failureScripts = Join-Path $failureRoot 'scripts'
  $failureBase = Join-Path $tempBase 'failure-base'
  $failureRuntime = Join-Path $failureBase 'runtime'
  New-Item -ItemType Directory -Force -Path $failureScripts, $failureRuntime | Out-Null
  Write-Utf8NoBom (Join-Path $failureScripts 'runtime-restart-handoff-windows.ps1') 'exit 7'
  Write-Starting (Join-Path $failureRuntime 'restart-transaction.json') $failureRoot 'OpenAI'
  $failure = Invoke-Starter $failureRoot $failureBase 3
  if ($failure.exitCode -eq 0) {
    throw "Starter falsely acknowledged a restart worker that exited immediately. STDOUT=$($failure.stdout) STDERR=$($failure.stderr)"
  }
  Write-Host 'Windows CIM durable restart starter early-exit path passed.' -ForegroundColor Green

  $timeoutRoot = Join-Path $tempBase 'timeout\vtest'
  $timeoutScripts = Join-Path $timeoutRoot 'scripts'
  $timeoutBase = Join-Path $tempBase 'timeout-base'
  $timeoutRuntime = Join-Path $timeoutBase 'runtime'
  New-Item -ItemType Directory -Force -Path $timeoutScripts, $timeoutRuntime | Out-Null
  Write-Utf8NoBom (Join-Path $timeoutScripts 'runtime-restart-handoff-windows.ps1') 'Start-Sleep -Seconds 10'
  Write-Starting (Join-Path $timeoutRuntime 'restart-transaction.json') $timeoutRoot 'OpenAI'
  $timeout = Invoke-Starter $timeoutRoot $timeoutBase 1
  if ($timeout.exitCode -eq 0) { throw 'Starter falsely acknowledged a worker that never wrote RUNNING.' }
  $combined = $timeout.stdout + [Environment]::NewLine + $timeout.stderr
  $pidMatch = [regex]::Match($combined, 'worker PID ([0-9]+) did not acknowledge')
  if (-not $pidMatch.Success) { throw "Starter timeout did not report worker PID. Output=$combined" }
  $timedOutPid = [int]$pidMatch.Groups[1].Value
  Start-Sleep -Milliseconds 200
  if (Get-Process -Id $timedOutPid -ErrorAction SilentlyContinue) {
    throw "Timed-out durable restart worker PID $timedOutPid survived starter failure."
  }
  Write-Host 'Windows CIM durable restart starter timeout-cleanup path passed.' -ForegroundColor Green
} finally {
  if ($workerPid -gt 0) { Stop-Process -Id $workerPid -Force -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $tempBase -Recurse -Force -ErrorAction SilentlyContinue
}
