param(
  [Parameter(Mandatory = $true)]
  [string]$Root,
  [Parameter(Mandatory = $true)]
  [int]$Port,
  [Parameter(Mandatory = $true)]
  [string]$StdoutLog,
  [Parameter(Mandatory = $true)]
  [string]$StderrLog
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$Root = (Resolve-Path $Root).Path
Set-Location $Root
$restartDelaysSeconds = @(1, 2, 5, 10, 30)
$restartAttempt = 0

function Append-HostLog([string]$Message) {
  "[$([DateTimeOffset]::UtcNow.ToString('o'))] $Message" | Add-Content -Path $StderrLog -Encoding utf8
}

while ($true) {
  $childStartedAt = [DateTimeOffset]::UtcNow
  try {
    $node = Get-Command node -ErrorAction Stop
    $entrypoint = Join-Path $Root 'dist\setup-web-cli.js'
    if (-not (Test-Path $entrypoint)) { throw "Control Center entrypoint not found: $entrypoint" }

    $args = @(
      "`"$entrypoint`"",
      '--no-open',
      '--persistent',
      '--strict-port',
      '--port',
      [string]$Port
    )
    $child = Start-Process `
      -FilePath $node.Source `
      -ArgumentList ($args -join ' ') `
      -WorkingDirectory $Root `
      -WindowStyle Hidden `
      -RedirectStandardOutput $StdoutLog `
      -RedirectStandardError $StderrLog `
      -PassThru `
      -Wait

    $lifetimeSeconds = ([DateTimeOffset]::UtcNow - $childStartedAt).TotalSeconds
    if ($lifetimeSeconds -ge 60) { $restartAttempt = 0 }
    Append-HostLog "Control Center child exited code=$($child.ExitCode) after=$([Math]::Round($lifetimeSeconds,1))s."
  } catch {
    Append-HostLog "Control Center child failure: $($_.Exception.Message)"
  }

  $delayIndex = [Math]::Min($restartAttempt, $restartDelaysSeconds.Count - 1)
  $delay = $restartDelaysSeconds[$delayIndex]
  Append-HostLog "Control Center watchdog restart in ${delay}s."
  Start-Sleep -Seconds $delay
  if ($restartAttempt -lt ($restartDelaysSeconds.Count - 1)) { $restartAttempt += 1 }
}
