Set-StrictMode -Version Latest

function Get-RwmcpTunnelPollFreshness {
  param(
    [Parameter(Mandatory = $true)][string]$MetricsText,
    [double]$NowUnixSeconds = ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() / 1000.0),
    [int]$MaxPollAgeSeconds = 75
  )
  if ($MaxPollAgeSeconds -lt 10 -or $MaxPollAgeSeconds -gt 600) {
    throw 'MaxPollAgeSeconds must be between 10 and 600 seconds.'
  }
  $pattern = '(?m)^commands_poll_last_successful_timestamp_seconds(?:\{[^}]*\})?\s+([0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)\s*$'
  $match = [regex]::Match($MetricsText, $pattern)
  if (-not $match.Success) {
    return [pscustomobject]@{
      fresh = $false
      seen = $false
      ageSeconds = $null
      lastSuccessfulPollUnixSeconds = $null
      reason = 'waiting-for-first-successful-poll'
    }
  }
  $last = [double]::Parse($match.Groups[1].Value, [Globalization.CultureInfo]::InvariantCulture)
  $age = [Math]::Max(0.0, $NowUnixSeconds - $last)
  $fresh = $age -le $MaxPollAgeSeconds
  return [pscustomobject]@{
    fresh = $fresh
    seen = $true
    ageSeconds = $age
    lastSuccessfulPollUnixSeconds = $last
    reason = if ($fresh) { 'control-plane-poll-fresh' } else { 'poll-stale' }
  }
}

function Get-RwmcpTunnelHealth {
  param(
    [Parameter(Mandatory = $true)][string]$HealthUrlPath,
    [int]$MaxPollAgeSeconds = 75
  )
  if (-not (Test-Path -LiteralPath $HealthUrlPath)) {
    return [pscustomobject]@{ connected = $false; ready = $false; pollFresh = $false; pollAgeSeconds = $null; reason = 'health-url-missing' }
  }
  try {
    $base = (Get-Content -LiteralPath $HealthUrlPath -Raw -ErrorAction Stop).Trim().TrimEnd('/')
    if (-not $base) { throw 'health URL is empty' }
    $readyResponse = Invoke-WebRequest -Uri "$base/readyz" -UseBasicParsing -TimeoutSec 2
    if ($readyResponse.StatusCode -ne 200) {
      return [pscustomobject]@{ connected = $false; ready = $false; pollFresh = $false; pollAgeSeconds = $null; reason = 'local-not-ready' }
    }
    $metricsResponse = Invoke-WebRequest -Uri "$base/metrics" -UseBasicParsing -TimeoutSec 2
    if ($metricsResponse.StatusCode -ne 200) {
      return [pscustomobject]@{ connected = $false; ready = $true; pollFresh = $false; pollAgeSeconds = $null; reason = 'metrics-unavailable' }
    }
    $poll = Get-RwmcpTunnelPollFreshness -MetricsText ([string]$metricsResponse.Content) -MaxPollAgeSeconds $MaxPollAgeSeconds
    return [pscustomobject]@{
      connected = [bool]$poll.fresh
      ready = $true
      pollFresh = [bool]$poll.fresh
      pollAgeSeconds = $poll.ageSeconds
      reason = [string]$poll.reason
    }
  } catch {
    return [pscustomobject]@{ connected = $false; ready = $false; pollFresh = $false; pollAgeSeconds = $null; reason = 'health-probe-failed' }
  }
}

function Test-RwmcpTunnelConnected {
  param(
    [Parameter(Mandatory = $true)][string]$HealthUrlPath,
    [int]$MaxPollAgeSeconds = 75
  )
  return [bool](Get-RwmcpTunnelHealth -HealthUrlPath $HealthUrlPath -MaxPollAgeSeconds $MaxPollAgeSeconds).connected
}
