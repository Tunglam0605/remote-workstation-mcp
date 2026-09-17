param(
  [Parameter(Mandatory = $true)][string]$Root,
  [Parameter(Mandatory = $true)][int]$Port,
  [Parameter(Mandatory = $true)][string]$StdoutLog,
  [Parameter(Mandatory = $true)][string]$StderrLog
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$Root = (Resolve-Path $Root).Path
Set-Location $Root
$webRestartDelaysSeconds = @(1, 2, 5, 10, 30)
$recoveryRestartDelaysSeconds = @(2, 4, 8, 15, 30, 60)
$webRestartAttempt = 0
$recoveryRestartAttempt = 0
$webNextStartAt = [DateTimeOffset]::MinValue
$recoveryNextStartAt = [DateTimeOffset]::MinValue
$webChild = $null
$recoveryChild = $null
$webStartedAt = $null
$recoveryStartedAt = $null
$stateDir = Split-Path -Parent $StderrLog
$hostLog = Join-Path $stateDir 'control-center-host.log'
$recoveryLog = Join-Path $stateDir 'autonomous-recovery.log'
$recoveryStdout = Join-Path $stateDir 'autonomous-recovery.stdout.log'
$recoveryStderr = Join-Path $stateDir 'autonomous-recovery.stderr.log'

function Append-HostLog([string]$Message) {
  "[$([DateTimeOffset]::UtcNow.ToString('o'))] $Message" | Add-Content -Path $hostLog -Encoding utf8
}

function Start-WebChild {
  $node = Get-Command node -ErrorAction Stop
  $entrypoint = Join-Path $Root 'dist\setup-web-cli.js'
  if (-not (Test-Path $entrypoint)) { throw "Control Center entrypoint not found: $entrypoint" }
  $args = @("`"$entrypoint`"", '--no-open', '--persistent', '--strict-port', '--port', [string]$Port)
  $script:webStartedAt = [DateTimeOffset]::UtcNow
  $script:webChild = Start-Process -FilePath $node.Source -ArgumentList ($args -join ' ') -WorkingDirectory $Root -WindowStyle Hidden -RedirectStandardOutput $StdoutLog -RedirectStandardError $StderrLog -PassThru
  Append-HostLog "Control Center WebUI child started pid=$($webChild.Id)."
}

function Start-RecoveryChild {
  $entrypoint = Join-Path $Root 'scripts\autonomous-recovery-windows.ps1'
  if (-not (Test-Path $entrypoint)) {
    Append-HostLog "Autonomous recovery child unavailable in this root: $entrypoint"
    $script:recoveryNextStartAt = [DateTimeOffset]::UtcNow.AddSeconds(30)
    return
  }
  $powershell = (Get-Command powershell.exe -ErrorAction Stop).Source
  $args = @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$entrypoint`"",'-Root',"`"$Root`"",'-LogPath',"`"$recoveryLog`"") -join ' '
  $script:recoveryStartedAt = [DateTimeOffset]::UtcNow
  $script:recoveryChild = Start-Process -FilePath $powershell -ArgumentList $args -WorkingDirectory $Root -WindowStyle Hidden -RedirectStandardOutput $recoveryStdout -RedirectStandardError $recoveryStderr -PassThru
  Append-HostLog "Autonomous recovery child started pid=$($recoveryChild.Id)."
}

function Observe-WebChild {
  if ($webChild) {
    try { $webChild.Refresh() } catch {}
    if (-not $webChild.HasExited) { return }
    $lifetime = ([DateTimeOffset]::UtcNow - $webStartedAt).TotalSeconds
    if ($lifetime -ge 60) { $script:webRestartAttempt = 0 }
    Append-HostLog "Control Center child exited code=$($webChild.ExitCode) after=$([Math]::Round($lifetime,1))s."
    $script:webChild = $null
    $delayIndex = [Math]::Min($webRestartAttempt, $webRestartDelaysSeconds.Count - 1)
    $delay = $webRestartDelaysSeconds[$delayIndex]
    $script:webNextStartAt = [DateTimeOffset]::UtcNow.AddSeconds($delay)
    Append-HostLog "Control Center watchdog restart in ${delay}s."
    if ($webRestartAttempt -lt ($webRestartDelaysSeconds.Count - 1)) { $script:webRestartAttempt += 1 }
  }
  if (-not $webChild -and [DateTimeOffset]::UtcNow -ge $webNextStartAt) {
    try { Start-WebChild }
    catch {
      Append-HostLog "Control Center child failure: $($_.Exception.Message)"
      $script:webNextStartAt = [DateTimeOffset]::UtcNow.AddSeconds($webRestartDelaysSeconds[[Math]::Min($webRestartAttempt, $webRestartDelaysSeconds.Count - 1)])
    }
  }
}

function Observe-RecoveryChild {
  if ($recoveryChild) {
    try { $recoveryChild.Refresh() } catch {}
    if (-not $recoveryChild.HasExited) { return }
    $lifetime = ([DateTimeOffset]::UtcNow - $recoveryStartedAt).TotalSeconds
    if ($lifetime -ge 60) { $script:recoveryRestartAttempt = 0 }
    Append-HostLog "Autonomous recovery child exited code=$($recoveryChild.ExitCode) after=$([Math]::Round($lifetime,1))s."
    $script:recoveryChild = $null
    $delayIndex = [Math]::Min($recoveryRestartAttempt, $recoveryRestartDelaysSeconds.Count - 1)
    $delay = $recoveryRestartDelaysSeconds[$delayIndex]
    $script:recoveryNextStartAt = [DateTimeOffset]::UtcNow.AddSeconds($delay)
    Append-HostLog "Autonomous recovery watchdog restart in ${delay}s."
    if ($recoveryRestartAttempt -lt ($recoveryRestartDelaysSeconds.Count - 1)) { $script:recoveryRestartAttempt += 1 }
  }
  if (-not $recoveryChild -and [DateTimeOffset]::UtcNow -ge $recoveryNextStartAt) {
    try { Start-RecoveryChild }
    catch {
      Append-HostLog "Autonomous recovery child failure: $($_.Exception.Message)"
      $script:recoveryNextStartAt = [DateTimeOffset]::UtcNow.AddSeconds($recoveryRestartDelaysSeconds[[Math]::Min($recoveryRestartAttempt, $recoveryRestartDelaysSeconds.Count - 1)])
    }
  }
}

while ($true) {
  Observe-WebChild
  Observe-RecoveryChild
  Start-Sleep -Seconds 1
}
