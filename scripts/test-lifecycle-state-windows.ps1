$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$tempLocal = Join-Path ([IO.Path]::GetTempPath()) ("rwmcp-lifecycle-state-" + [Guid]::NewGuid().ToString('N'))
$savedLocal = $env:LOCALAPPDATA
$env:LOCALAPPDATA = $tempLocal
try {
  . (Join-Path $repoRoot 'scripts\windows-settings.ps1')
  . (Join-Path $repoRoot 'scripts\windows-lifecycle-state.ps1')
  $initial = Get-RwmcpLifecycleState
  if ([int64]$initial.epoch -ne 0 -or (Test-RwmcpLifecycleTransactionActive)) { throw 'Unexpected initial lifecycle state.' }

  $first = Begin-RwmcpLifecycleTransaction -Kind boot -LeaseSeconds 60 -Message 'test boot'
  if ([int64]$first.epoch -ne 1 -or -not (Test-RwmcpLifecycleTransactionActive)) { throw 'First lifecycle transaction did not become active.' }
  $completed = Complete-RwmcpLifecycleTransaction -Epoch ([int64]$first.epoch) -Outcome SUCCEEDED -Message 'done'
  if ([string]$completed.state -ne 'SUCCEEDED' -or (Test-RwmcpLifecycleTransactionActive)) { throw 'Completed lifecycle transaction remained active.' }

  $second = Begin-RwmcpLifecycleTransaction -Kind update -LeaseSeconds 60 -Message 'test update'
  if ([int64]$second.epoch -ne 2) { throw "Lifecycle epoch was not monotonic: $($second.epoch)" }
  Complete-RwmcpLifecycleTransaction -Epoch ([int64]$second.epoch) -Outcome SUCCEEDED | Out-Null

  $path = Get-RwmcpLifecycleStatePath
  $stale = [ordered]@{
    version=1; epoch=3; state='RUNNING'; kind='recovery'; ownerPid=2147483000;
    ownerStartedAt=[DateTimeOffset]::UtcNow.ToString('o'); leaseUntil=[DateTimeOffset]::UtcNow.AddMinutes(5).ToString('o');
    startedAt=[DateTimeOffset]::UtcNow.ToString('o'); updatedAt=[DateTimeOffset]::UtcNow.ToString('o'); message='stale'
  }
  [IO.File]::WriteAllText($path, ($stale | ConvertTo-Json) + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
  if (Test-RwmcpLifecycleTransactionActive) { throw 'Missing lifecycle owner PID was incorrectly treated as active.' }
  Write-Host 'Lifecycle state/epoch test passed.' -ForegroundColor Green
} finally {
  $env:LOCALAPPDATA = $savedLocal
  Remove-Item -LiteralPath $tempLocal -Recurse -Force -ErrorAction SilentlyContinue
}
