$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'lib\tunnel-health-windows.ps1')

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

$now = 2000.0
$fresh = Get-RwmcpTunnelPollFreshness -MetricsText "commands_poll_last_successful_timestamp_seconds{otel_scope_name=`"controlplane`"} 1.970e+03`n" -NowUnixSeconds $now -MaxPollAgeSeconds 75
Assert-True $fresh.fresh 'Recent successful poll should be fresh.'
Assert-True ($fresh.reason -eq 'control-plane-poll-fresh') 'Fresh poll reason mismatch.'

$stale = Get-RwmcpTunnelPollFreshness -MetricsText "commands_poll_last_successful_timestamp_seconds 1800`n" -NowUnixSeconds $now -MaxPollAgeSeconds 75
Assert-True (-not $stale.fresh) 'Stale successful poll should not be fresh.'
Assert-True ($stale.reason -eq 'poll-stale') 'Stale poll reason mismatch.'

$missing = Get-RwmcpTunnelPollFreshness -MetricsText "commands_poll_cycles_total 4`n" -NowUnixSeconds $now -MaxPollAgeSeconds 75
Assert-True (-not $missing.fresh) 'Missing successful poll metric must not be accepted.'
Assert-True ($missing.reason -eq 'waiting-for-first-successful-poll') 'Missing poll reason mismatch.'

Write-Host 'Windows tunnel poll-health tests passed.'
