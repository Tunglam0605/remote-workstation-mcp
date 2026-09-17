$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$tempLocal = Join-Path ([IO.Path]::GetTempPath()) ("rwmcp-recovery-circuit-" + [Guid]::NewGuid().ToString('N'))
$savedLocal = $env:LOCALAPPDATA
$env:LOCALAPPDATA = $tempLocal
try {
  . (Join-Path $repoRoot 'scripts\windows-settings.ps1')
  . (Join-Path $repoRoot 'scripts\windows-recovery-circuit.ps1')
  $now = [DateTimeOffset]::Parse('2026-09-17T00:00:00Z')
  if (-not (Test-RwmcpRecoveryCircuitAllowsAction -Now $now)) { throw 'Fresh circuit should allow recovery.' }

  $expectedDelays = @(2,4,8,15,30)
  for ($i = 0; $i -lt 5; $i++) {
    $state = Register-RwmcpRecoveryFailure -Reason "failure-$($i+1)" -Now $now
    if ([int]$state.failureCount -ne ($i + 1)) { throw 'Recovery failure count did not increment.' }
    $cooldown = [DateTimeOffset]::Parse([string]$state.cooldownUntil)
    $actualDelay = [int][Math]::Round(($cooldown - $now).TotalSeconds)
    if ($actualDelay -ne $expectedDelays[$i]) { throw "Unexpected cooldown $actualDelay for failure $($i+1)." }
    if (Test-RwmcpRecoveryCircuitAllowsAction -Now $now) { throw 'Circuit allowed an action during cooldown.' }
    $now = $cooldown.AddMilliseconds(1)
  }

  $sixth = Register-RwmcpRecoveryFailure -Reason 'failure-6' -Now $now
  if ([int]$sixth.failureCount -ne 6 -or -not $sixth.openUntil) { throw 'Sixth failure did not open the circuit.' }
  $openUntil = [DateTimeOffset]::Parse([string]$sixth.openUntil)
  if ([int][Math]::Round(($openUntil - $now).TotalMinutes) -ne 5) { throw 'Open circuit duration is not five minutes.' }
  if (Test-RwmcpRecoveryCircuitAllowsAction -Now $now.AddMinutes(1)) { throw 'Open circuit allowed recovery too early.' }
  if (-not (Test-RwmcpRecoveryCircuitAllowsAction -Now $openUntil.AddMilliseconds(1))) { throw 'Expired open circuit did not allow recovery.' }

  $reset = Reset-RwmcpRecoveryCircuit -Reason healthy -Now $openUntil.AddSeconds(1)
  if ([int]$reset.failureCount -ne 0 -or -not (Test-RwmcpRecoveryCircuitAllowsAction -Now $openUntil.AddSeconds(1))) { throw 'Healthy reset did not close the circuit.' }
  Write-Host 'Recovery circuit breaker test passed.' -ForegroundColor Green
} finally {
  $env:LOCALAPPDATA = $savedLocal
  Remove-Item -LiteralPath $tempLocal -Recurse -Force -ErrorAction SilentlyContinue
}
