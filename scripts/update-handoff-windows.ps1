param(
  [string]$Base = '',
  [string]$ExpectedVersion = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ([string]::IsNullOrWhiteSpace($Base)) {
  $localBase = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $HOME 'AppData\Local' }
  $Base = Join-Path $localBase 'RemoteWorkstationMCP'
}
$Base = [IO.Path]::GetFullPath($Base)
$RuntimeDir = Join-Path $Base 'runtime'
$StatePath = Join-Path $RuntimeDir 'update-transaction.json'
$LogPath = Join-Path $RuntimeDir 'update-worker.log'
$CurrentFile = Join-Path $Base 'current.txt'
$Launcher = Join-Path $Base 'bin\rwmcp.ps1'
$StartedAt = [DateTimeOffset]::UtcNow.ToString('o')
New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null

function Append-UpdateLog([string]$Message) {
  "[$([DateTimeOffset]::UtcNow.ToString('o'))] $Message" | Add-Content -Path $LogPath -Encoding utf8
}

function Get-CurrentVersion {
  if (-not (Test-Path -LiteralPath $CurrentFile)) { return $null }
  try {
    $root = (Get-Content -LiteralPath $CurrentFile -Raw -ErrorAction Stop).Trim()
    if (-not $root) { return $null }
    $manifestPath = Join-Path $root 'package.json'
    if (-not (Test-Path -LiteralPath $manifestPath)) { return $null }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -ErrorAction Stop | ConvertFrom-Json
    return [string]$manifest.version
  } catch {
    return $null
  }
}

function Write-AtomicUtf8File([string]$Path, [string]$Content) {
  $directory = Split-Path -Parent $Path
  if ($directory) { New-Item -ItemType Directory -Force -Path $directory | Out-Null }
  $nonce = [Guid]::NewGuid().ToString('N')
  $tmp = "$Path.tmp.$PID.$nonce"
  $backup = "$Path.bak.$PID.$nonce"
  try {
    [IO.File]::WriteAllText($tmp, $Content, (New-Object Text.UTF8Encoding($false)))
    for ($attempt = 0; $attempt -lt 3; $attempt += 1) {
      try {
        if (Test-Path -LiteralPath $Path) {
          [IO.File]::Replace($tmp, $Path, $backup, $true)
        } else {
          [IO.File]::Move($tmp, $Path)
        }
        return
      } catch [System.IO.FileNotFoundException] {
        if ($attempt -ge 2) { throw }
        Start-Sleep -Milliseconds 25
      } catch [System.IO.IOException] {
        if ($attempt -ge 2) { throw }
        Start-Sleep -Milliseconds 25
      }
    }
  } finally {
    foreach ($artifact in @($tmp, $backup)) {
      if (Test-Path -LiteralPath $artifact) {
        Remove-Item -LiteralPath $artifact -Force -ErrorAction SilentlyContinue
      }
    }
  }
}

function Write-Transaction(
  [string]$State,
  [string]$Message,
  [string]$FromVersion,
  [string]$ToVersion,
  [Nullable[int]]$ExitCode = $null,
  [string]$Recovery = ''
) {
  $payload = [ordered]@{
    version = 1
    state = $State
    workerPid = $PID
    fromVersion = $FromVersion
    toVersion = $ToVersion
    expectedVersion = if ($ExpectedVersion) { $ExpectedVersion.TrimStart('v') } else { $null }
    startedAt = $StartedAt
    updatedAt = [DateTimeOffset]::UtcNow.ToString('o')
    exitCode = $ExitCode
    recovery = if ($Recovery) { $Recovery } else { $null }
    message = $Message
    logPath = $LogPath
  }
  $json = $payload | ConvertTo-Json -Depth 6
  Write-AtomicUtf8File $StatePath ($json + [Environment]::NewLine)
}

function Invoke-LauncherAction([string]$Action) {
  $powershell = Get-Command powershell.exe -ErrorAction Stop
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $powershell.Source
  $psi.Arguments = "-NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$Launcher`" -Action $Action"
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

$mutex = New-Object System.Threading.Mutex($false, 'Local\RemoteWorkstationMCP.UpdateHandoff')
$lockAcquired = $false
try {
  try {
    $lockAcquired = $mutex.WaitOne(0)
  } catch [System.Threading.AbandonedMutexException] {
    $lockAcquired = $true
  }
  if (-not $lockAcquired) {
    Append-UpdateLog 'Another durable update worker already owns the update handoff mutex; exiting duplicate worker.'
    exit 3
  }

  $fromVersion = Get-CurrentVersion
  Write-Transaction 'RUNNING' 'Durable Windows update worker started.' $fromVersion $fromVersion
  Append-UpdateLog "Update worker started pid=$PID fromVersion=$fromVersion expectedVersion=$ExpectedVersion"

  if (-not (Test-Path -LiteralPath $Launcher)) {
    throw "Stable launcher is missing: $Launcher"
  }

  $updateExitCode = Invoke-LauncherAction 'Update'
  if ($updateExitCode -ne 0) {
    throw "Stable launcher Update exited with code $updateExitCode."
  }

  $toVersion = Get-CurrentVersion
  if (-not $toVersion) {
    throw 'Update completed without a readable current runtime version.'
  }
  if ($ExpectedVersion) {
    try {
      if ([version]$toVersion -lt [version]$ExpectedVersion.TrimStart('v')) {
        throw "Activated version $toVersion is older than expected $ExpectedVersion."
      }
    } catch [System.Management.Automation.RuntimeException] {
      throw
    } catch {
      throw "Unable to compare activated version '$toVersion' with expected version '$ExpectedVersion'."
    }
  }

  Write-Transaction 'SUCCEEDED' "Update activated successfully at v$toVersion." $fromVersion $toVersion 0
  Append-UpdateLog "Update worker succeeded from=$fromVersion to=$toVersion"
  exit 0
} catch {
  $message = $_.Exception.Message
  $fromVersion = if (Get-Variable fromVersion -Scope 0 -ErrorAction SilentlyContinue) { [string]$fromVersion } else { [string](Get-CurrentVersion) }
  $toVersion = [string](Get-CurrentVersion)
  Append-UpdateLog "Update worker failure: $message"

  $recovery = 'not-attempted'
  if (Test-Path -LiteralPath $Launcher) {
    try {
      Append-UpdateLog 'Attempting best-effort StartOpenAI recovery on the current slot.'
      $recoveryExit = Invoke-LauncherAction 'StartOpenAI'
      if ($recoveryExit -eq 0) { $recovery = 'start-openai-ok' }
      else { $recovery = "start-openai-exit-$recoveryExit" }
    } catch {
      $recovery = 'start-openai-error'
      Append-UpdateLog "Recovery launch failed: $($_.Exception.Message)"
    }
  }

  Write-Transaction 'FAILED' $message $fromVersion $toVersion 1 $recovery
  exit 1
} finally {
  if ($lockAcquired) {
    try { $mutex.ReleaseMutex() } catch {}
  }
  $mutex.Dispose()
}
