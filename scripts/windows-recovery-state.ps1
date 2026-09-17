Set-StrictMode -Version Latest

if (-not (Get-Command Get-RwmcpUserConfigDir -ErrorAction SilentlyContinue)) {
  . (Join-Path $PSScriptRoot 'windows-settings.ps1')
}

function Get-RwmcpDesiredStatePath {
  return Join-Path (Get-RwmcpUserConfigDir) 'runtime\desired-state.json'
}

function New-RwmcpDefaultDesiredState {
  return [pscustomobject]@{
    version = 1
    desiredRunning = $false
    mode = 'OpenAI'
    reason = 'not-configured'
    maintenanceUntil = $null
    updatedAt = [DateTimeOffset]::UtcNow.ToString('o')
  }
}

function Get-RwmcpDesiredState {
  $path = Get-RwmcpDesiredStatePath
  if (-not (Test-Path -LiteralPath $path)) { return New-RwmcpDefaultDesiredState }
  try {
    $state = Get-Content -LiteralPath $path -Raw -ErrorAction Stop | ConvertFrom-Json
    if (-not ($state.PSObject.Properties.Name -contains 'desiredRunning')) { return New-RwmcpDefaultDesiredState }
    if (-not ($state.PSObject.Properties.Name -contains 'mode')) { $state | Add-Member -NotePropertyName mode -NotePropertyValue 'OpenAI' }
    if (-not ($state.PSObject.Properties.Name -contains 'reason')) { $state | Add-Member -NotePropertyName reason -NotePropertyValue 'unknown' }
    if (-not ($state.PSObject.Properties.Name -contains 'maintenanceUntil')) { $state | Add-Member -NotePropertyName maintenanceUntil -NotePropertyValue $null }
    return $state
  } catch {
    return New-RwmcpDefaultDesiredState
  }
}

function Write-RwmcpDesiredState($State) {
  $path = Get-RwmcpDesiredStatePath
  $dir = Split-Path -Parent $path
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $tmp = "$path.tmp"
  $json = $State | ConvertTo-Json -Depth 5
  [IO.File]::WriteAllText($tmp, $json + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $tmp -Destination $path -Force
  return Get-RwmcpDesiredState
}

function Set-RwmcpDesiredState {
  param(
    [Parameter(Mandatory = $true)][bool]$DesiredRunning,
    [ValidateSet('Local','OpenAI')][string]$Mode = 'OpenAI',
    [string]$Reason = 'runtime-action'
  )
  $current = Get-RwmcpDesiredState
  $state = [ordered]@{
    version = 1
    desiredRunning = $DesiredRunning
    mode = $Mode
    reason = $Reason
    maintenanceUntil = $current.maintenanceUntil
    updatedAt = [DateTimeOffset]::UtcNow.ToString('o')
  }
  return Write-RwmcpDesiredState ([pscustomobject]$state)
}

function Set-RwmcpRecoveryMaintenance {
  param(
    [ValidateRange(1,3600)][int]$Seconds = 240,
    [string]$Reason = 'planned-maintenance',
    [ValidateSet('Local','OpenAI')][string]$Mode = 'OpenAI'
  )
  $current = Get-RwmcpDesiredState
  $state = [ordered]@{
    version = 1
    desiredRunning = if ($current.reason -eq 'not-configured') { $true } else { [bool]$current.desiredRunning }
    mode = if ($current.reason -eq 'not-configured') { $Mode } else { [string]$current.mode }
    reason = $Reason
    maintenanceUntil = [DateTimeOffset]::UtcNow.AddSeconds($Seconds).ToString('o')
    updatedAt = [DateTimeOffset]::UtcNow.ToString('o')
  }
  return Write-RwmcpDesiredState ([pscustomobject]$state)
}

function Clear-RwmcpRecoveryMaintenance {
  param([string]$Reason = 'maintenance-complete')
  $current = Get-RwmcpDesiredState
  $state = [ordered]@{
    version = 1
    desiredRunning = [bool]$current.desiredRunning
    mode = [string]$current.mode
    reason = $Reason
    maintenanceUntil = $null
    updatedAt = [DateTimeOffset]::UtcNow.ToString('o')
  }
  return Write-RwmcpDesiredState ([pscustomobject]$state)
}

function Test-RwmcpRecoveryMaintenanceActive {
  $state = Get-RwmcpDesiredState
  if (-not $state.maintenanceUntil) { return $false }
  try { return [DateTimeOffset]::Parse([string]$state.maintenanceUntil) -gt [DateTimeOffset]::UtcNow }
  catch { return $false }
}
