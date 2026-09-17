param(
  [Parameter(Mandatory = $true)]
  [string]$Root,
  [ValidateSet('Local','OpenAI')]
  [string]$Mode = 'OpenAI',
  [ValidateRange(100,5000)]
  [int]$DelayMs = 750,
  [string]$Base = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$Root = (Resolve-Path $Root).Path
if ([string]::IsNullOrWhiteSpace($Base)) {
  $versionsDir = Split-Path -Parent $Root
  if ((Split-Path -Leaf $versionsDir) -eq 'versions') {
    $Base = Split-Path -Parent $versionsDir
  } else {
    $localBase = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $HOME 'AppData\Local' }
    $Base = Join-Path $localBase 'RemoteWorkstationMCP'
  }
}
$Base = [IO.Path]::GetFullPath($Base)
$RuntimeDir = Join-Path $Base 'runtime'
$StatePath = Join-Path $RuntimeDir 'restart-transaction.json'
$LogPath = Join-Path $RuntimeDir 'restart-worker.log'
$StartedAt = [DateTimeOffset]::UtcNow.ToString('o')
$runtimeScript = Join-Path $Root 'scripts\runtime-control-windows.ps1'
New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null

function Append-RestartLog([string]$Message) {
  "[$([DateTimeOffset]::UtcNow.ToString('o'))] $Message" | Add-Content -Path $LogPath -Encoding utf8
}

function Write-Transaction(
  [string]$State,
  [string]$Message,
  [Nullable[int]]$ExitCode = $null,
  [string]$Recovery = ''
) {
  $payload = [ordered]@{
    version = 1
    state = $State
    workerPid = $PID
    root = $Root
    mode = $Mode
    startedAt = $StartedAt
    updatedAt = [DateTimeOffset]::UtcNow.ToString('o')
    exitCode = $ExitCode
    recovery = if ($Recovery) { $Recovery } else { $null }
    message = $Message
    logPath = $LogPath
  }
  $tmp = "$StatePath.tmp"
  [IO.File]::WriteAllText($tmp, ($payload | ConvertTo-Json -Depth 6) + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $tmp -Destination $StatePath -Force
}

function Invoke-RuntimeAction([string]$Action) {
  $powershell = Get-Command powershell.exe -ErrorAction Stop
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $powershell.Source
  $psi.Arguments = "-NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$runtimeScript`" -Action $Action -Mode $Mode -Root `"$Root`""
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
    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    if ($stdout) { $stdout.TrimEnd() | Add-Content -Path $LogPath -Encoding utf8 }
    if ($stderr) { $stderr.TrimEnd() | Add-Content -Path $LogPath -Encoding utf8 }
    return [int]$process.ExitCode
  } finally {
    $process.Dispose()
  }
}

$mutex = New-Object System.Threading.Mutex($false, 'Local\RemoteWorkstationMCP.RestartHandoff')
$lockAcquired = $false
try {
  try { $lockAcquired = $mutex.WaitOne(0) }
  catch [System.Threading.AbandonedMutexException] { $lockAcquired = $true }
  if (-not $lockAcquired) {
    Append-RestartLog 'Another restart worker already owns the restart handoff mutex; exiting duplicate worker.'
    exit 3
  }
  if (-not (Test-Path -LiteralPath $runtimeScript)) { throw "Runtime control script is missing: $runtimeScript" }

  Write-Transaction 'RUNNING' 'Durable Windows restart worker started.'
  Append-RestartLog "Restart worker started pid=$PID mode=$Mode root=$Root"
  Start-Sleep -Milliseconds $DelayMs

  $restartExit = Invoke-RuntimeAction 'Restart'
  if ($restartExit -ne 0) { throw "Runtime Restart exited with code $restartExit." }

  Write-Transaction 'SUCCEEDED' 'Runtime restart completed successfully.' 0
  Append-RestartLog 'Restart worker succeeded.'
  exit 0
} catch {
  $message = $_.Exception.Message
  Append-RestartLog "Restart worker failure: $message"
  $recovery = 'not-attempted'
  try {
    Append-RestartLog 'Attempting best-effort runtime Start recovery.'
    $startExit = Invoke-RuntimeAction 'Start'
    if ($startExit -eq 0) { $recovery = 'start-ok' }
    else { $recovery = "start-exit-$startExit" }
  } catch {
    $recovery = 'start-error'
    Append-RestartLog "Recovery Start failed: $($_.Exception.Message)"
  }
  Write-Transaction 'FAILED' $message 1 $recovery
  exit 1
} finally {
  if ($lockAcquired) { try { $mutex.ReleaseMutex() } catch {} }
  $mutex.Dispose()
}
