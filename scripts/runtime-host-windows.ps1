param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Local','OpenAI')]
  [string]$Mode,
  [Parameter(Mandatory = $true)]
  [string]$Root,
  [Parameter(Mandatory = $true)]
  [string]$StdoutLog,
  [Parameter(Mandatory = $true)]
  [string]$StderrLog
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Root = (Resolve-Path $Root).Path
Set-Location $Root

$node = Get-Command node -ErrorAction Stop
$entrypoint = if ($Mode -eq 'OpenAI') {
  Join-Path $Root 'dist\openai-tunnel-cli.js'
} else {
  Join-Path $Root 'dist\cli.js'
}
if (-not (Test-Path $entrypoint)) { throw "Runtime entrypoint not found: $entrypoint" }

$stateDir = Split-Path -Parent $StdoutLog
$connectionStatePath = Join-Path $stateDir 'connection-state.json'
$healthUrlPath = Join-Path $Root 'runtime\openai-tunnel\health-url'
$restartDelaysSeconds = @(1, 2, 5, 10, 30)
$failureCount = 0
$attempt = 0

function Write-ConnectionState([string]$state, [string]$reason, [int]$attemptNumber, [Nullable[int]]$childPid = $null) {
  $payload = [ordered]@{
    state = $state
    reason = $reason
    mode = $Mode
    attempt = $attemptNumber
    childPid = $childPid
    updatedAt = [DateTimeOffset]::UtcNow.ToString('o')
  }
  $tmp = "$connectionStatePath.tmp"
  $payload | ConvertTo-Json | Set-Content -Path $tmp -Encoding utf8
  Move-Item -Path $tmp -Destination $connectionStatePath -Force
}

function Append-WatchdogLog([string]$message) {
  "[$([DateTimeOffset]::UtcNow.ToString('o'))] $message" | Add-Content -Path $StderrLog -Encoding utf8
}

$tunnelHealthScript = Join-Path $Root 'scripts\lib\tunnel-health-windows.ps1'
if (-not (Test-Path $tunnelHealthScript)) { throw "Tunnel health helper not found: $tunnelHealthScript" }
. $tunnelHealthScript
$TunnelPollMaxAgeSeconds = 75
$InitialControlPlaneGraceSeconds = 60
$PostReadyFailureGraceSeconds = 15

function Get-TunnelHealth {
  return Get-RwmcpTunnelHealth -HealthUrlPath $healthUrlPath -MaxPollAgeSeconds $TunnelPollMaxAgeSeconds
}

function Stop-ChildTree([int]$processId) {
  $taskkill = Get-Command taskkill.exe -ErrorAction SilentlyContinue
  if ($taskkill) {
    & $taskkill.Source /PID $processId /T /F *> $null
    return
  }
  Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
}

function Merge-AttemptLogs([string]$attemptStdout, [string]$attemptStderr) {
  if (Test-Path $attemptStdout) {
    $text = Get-Content -Path $attemptStdout -Raw -ErrorAction SilentlyContinue
    if ($text) { $text | Add-Content -Path $StdoutLog -Encoding utf8 }
    Remove-Item -Path $attemptStdout -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path $attemptStderr) {
    $text = Get-Content -Path $attemptStderr -Raw -ErrorAction SilentlyContinue
    if ($text) { $text | Add-Content -Path $StderrLog -Encoding utf8 }
    Remove-Item -Path $attemptStderr -Force -ErrorAction SilentlyContinue
  }
}

while ($true) {
  $attempt += 1
  $started = [DateTimeOffset]::UtcNow
  $stamp = $started.ToString('yyyyMMdd-HHmmss-fff')
  $attemptStdout = Join-Path $stateDir "supervisor.attempt-$stamp.stdout.log"
  $attemptStderr = Join-Path $stateDir "supervisor.attempt-$stamp.stderr.log"
  $args = @("`"$entrypoint`"")
  if ($Mode -eq 'Local') { $args += '--http' }

  Write-ConnectionState 'RECONNECTING' 'starting-runtime-child' $attempt
  Append-WatchdogLog "runtime child start attempt=$attempt mode=$Mode"

  try {
    $child = Start-Process `
      -FilePath $node.Source `
      -ArgumentList ($args -join ' ') `
      -WorkingDirectory $Root `
      -WindowStyle Hidden `
      -RedirectStandardOutput $attemptStdout `
      -RedirectStandardError $attemptStderr `
      -PassThru
  } catch {
    Append-WatchdogLog "runtime child launch failure attempt=$attempt error=$($_.Exception.Message)"
    $child = $null
  }

  if (-not $child) {
    $exitCode = 1
  } elseif ($Mode -eq 'Local') {
    Write-ConnectionState 'ONLINE' 'local-runtime-started' $attempt $child.Id
    $child.WaitForExit()
    $exitCode = [int]$child.ExitCode
  } else {
    Write-ConnectionState 'RECONNECTING' 'waiting-for-tunnel-ready' $attempt $child.Id
    $everReady = $false
    $unreadySince = [DateTimeOffset]::UtcNow

    while (-not $child.HasExited) {
      $tunnelHealth = Get-TunnelHealth
      if ($tunnelHealth.connected) {
        if (-not $everReady) {
          $everReady = $true
          Append-WatchdogLog "OpenAI tunnel ONLINE with fresh control-plane polling attempt=$attempt childPid=$($child.Id)"
        }
        $unreadySince = $null
        Write-ConnectionState 'ONLINE' 'control-plane-poll-fresh' $attempt $child.Id
      } else {
        if ($null -eq $unreadySince) { $unreadySince = [DateTimeOffset]::UtcNow }
        $unreadySeconds = ([DateTimeOffset]::UtcNow - $unreadySince).TotalSeconds
        $healthReason = [string]$tunnelHealth.reason
        $reason = if ($healthReason -eq 'poll-stale') { 'control-plane-poll-stale' } elseif ($everReady) { "tunnel-readiness-lost:$healthReason" } else { $healthReason }
        Write-ConnectionState 'RECONNECTING' $reason $attempt $child.Id
        $limit = if ($everReady) { $PostReadyFailureGraceSeconds } else { $InitialControlPlaneGraceSeconds }
        if ($unreadySeconds -ge $limit) {
          Append-WatchdogLog "OpenAI tunnel control-plane health lost reason=$healthReason for $([Math]::Round($unreadySeconds,1))s; recycling childPid=$($child.Id) attempt=$attempt"
          Stop-ChildTree $child.Id
          break
        }
      }
      Start-Sleep -Seconds 2
      try { $child.Refresh() } catch {}
    }

    try { if (-not $child.HasExited) { $child.WaitForExit(10000) | Out-Null } } catch {}
    $exitCode = if ($child.HasExited) { [int]$child.ExitCode } else { 1 }
  }

  Merge-AttemptLogs $attemptStdout $attemptStderr
  if ($Mode -ne 'OpenAI') {
    Write-ConnectionState 'OFFLINE' "runtime-child-exited:$exitCode" $attempt
    exit $exitCode
  }

  $lifetimeSeconds = ([DateTimeOffset]::UtcNow - $started).TotalSeconds
  if ($lifetimeSeconds -ge 60) { $failureCount = 0 }
  $delayIndex = [Math]::Min($failureCount, $restartDelaysSeconds.Count - 1)
  $delaySeconds = $restartDelaysSeconds[$delayIndex]
  $failureCount += 1
  Write-ConnectionState 'RECONNECTING' "runtime-child-exited:$exitCode;retry-in:${delaySeconds}s" $attempt
  Append-WatchdogLog "OpenAI runtime child exited code=$exitCode after=$([Math]::Round($lifetimeSeconds,1))s; watchdog restart in ${delaySeconds}s."
  Start-Sleep -Seconds $delaySeconds
}
