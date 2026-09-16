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
  $tmp = "$StatePath.tmp"
  $json = $payload | ConvertTo-Json -Depth 6
  [IO.File]::WriteAllText($tmp, $json + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $tmp -Destination $StatePath -Force
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

  & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $Launcher -Action Update *>> $LogPath
  $updateExitCode = $LASTEXITCODE
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
      & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $Launcher -Action StartOpenAI *>> $LogPath
      $recoveryExit = $LASTEXITCODE
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
