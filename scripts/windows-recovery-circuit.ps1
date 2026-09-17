Set-StrictMode -Version Latest

if (-not (Get-Command Get-RwmcpUserConfigDir -ErrorAction SilentlyContinue)) {
  . (Join-Path $PSScriptRoot 'windows-settings.ps1')
}

$script:RwmcpRecoveryDelaysSeconds = @(2, 4, 8, 15, 30, 60)

function Get-RwmcpRecoveryCircuitPath {
  return Join-Path (Get-RwmcpUserConfigDir) 'runtime\recovery-circuit.json'
}

function New-RwmcpRecoveryCircuitState {
  return [pscustomobject]@{
    version = 1
    failureCount = 0
    cooldownUntil = $null
    openUntil = $null
    lastReason = $null
    updatedAt = [DateTimeOffset]::UtcNow.ToString('o')
  }
}

function Get-RwmcpRecoveryCircuitState {
  $path = Get-RwmcpRecoveryCircuitPath
  if (-not (Test-Path -LiteralPath $path)) { return New-RwmcpRecoveryCircuitState }
  try {
    $state = Get-Content -LiteralPath $path -Raw -ErrorAction Stop | ConvertFrom-Json
    foreach ($name in @('version','failureCount','cooldownUntil','openUntil','lastReason','updatedAt')) {
      if (-not ($state.PSObject.Properties.Name -contains $name)) { return New-RwmcpRecoveryCircuitState }
    }
    return $state
  } catch {
    return New-RwmcpRecoveryCircuitState
  }
}

function Write-RwmcpRecoveryCircuitState($State) {
  $path = Get-RwmcpRecoveryCircuitPath
  $dir = Split-Path -Parent $path
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $tmp = "$path.tmp.$PID"
  [IO.File]::WriteAllText($tmp, ($State | ConvertTo-Json -Depth 5) + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $tmp -Destination $path -Force
  return Get-RwmcpRecoveryCircuitState
}

function Register-RwmcpRecoveryFailure {
  param(
    [Parameter(Mandatory = $true)][string]$Reason,
    [DateTimeOffset]$Now = [DateTimeOffset]::UtcNow
  )
  $current = Get-RwmcpRecoveryCircuitState
  $count = [int]$current.failureCount + 1
  $delayIndex = [Math]::Min($count - 1, $script:RwmcpRecoveryDelaysSeconds.Count - 1)
  $delay = $script:RwmcpRecoveryDelaysSeconds[$delayIndex]
  $openUntil = $null
  $cooldownUntil = $Now.AddSeconds($delay)
  if ($count -ge 6) {
    $openUntil = $Now.AddMinutes(5)
    $cooldownUntil = $openUntil
  }
  $state = [ordered]@{
    version = 1
    failureCount = $count
    cooldownUntil = $cooldownUntil.ToString('o')
    openUntil = if ($openUntil) { $openUntil.ToString('o') } else { $null }
    lastReason = $Reason
    updatedAt = $Now.ToString('o')
  }
  return Write-RwmcpRecoveryCircuitState ([pscustomobject]$state)
}

function Reset-RwmcpRecoveryCircuit {
  param(
    [string]$Reason = 'healthy',
    [DateTimeOffset]$Now = [DateTimeOffset]::UtcNow
  )
  $state = [ordered]@{
    version = 1
    failureCount = 0
    cooldownUntil = $null
    openUntil = $null
    lastReason = $Reason
    updatedAt = $Now.ToString('o')
  }
  return Write-RwmcpRecoveryCircuitState ([pscustomobject]$state)
}

function Test-RwmcpRecoveryCircuitAllowsAction {
  param([DateTimeOffset]$Now = [DateTimeOffset]::UtcNow)
  $state = Get-RwmcpRecoveryCircuitState
  if ($state.openUntil) {
    try { if ([DateTimeOffset]::Parse([string]$state.openUntil) -gt $Now) { return $false } } catch { return $false }
  }
  if ($state.cooldownUntil) {
    try { if ([DateTimeOffset]::Parse([string]$state.cooldownUntil) -gt $Now) { return $false } } catch { return $false }
  }
  return $true
}
