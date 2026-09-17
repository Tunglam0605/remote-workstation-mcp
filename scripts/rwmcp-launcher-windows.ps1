param(
  [ValidateSet('Setup','Start','StartOpenAI','Boot','Stop','Restart','Status','AutostartOn','AutostartOff','Update','UpdateCheck','AutoUpdateOn','AutoUpdateOff','Rollback')]
  [string]$Action = 'Setup'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$Base = Split-Path -Parent $PSScriptRoot
$CurrentFile = Join-Path $Base 'current.txt'
$PreviousFile = Join-Path $Base 'previous.txt'
$Installer = Join-Path $Base 'bin\install-windows-release.ps1'
$Updater = Join-Path $Base 'bin\update-windows.ps1'
$env:RWMCP_POLICY = Join-Path $Base 'config\policy.yaml'
$env:RWMCP_HOSTS = Join-Path $Base 'config\hosts.yaml'

function Get-CurrentRoot {
  if (-not (Test-Path $CurrentFile)) { throw 'Remote Workstation MCP current runtime pointer is missing.' }
  $root = (Get-Content -Path $CurrentFile -Raw).Trim()
  if (-not (Test-Path $root)) { throw "Installed runtime does not exist: $root" }
  return $root
}

function Get-RecoveryRoot {
  foreach ($pointer in @($CurrentFile, $PreviousFile)) {
    if (-not (Test-Path $pointer)) { continue }
    try {
      $candidate = (Get-Content -Path $pointer -Raw -ErrorAction Stop).Trim()
      if (-not $candidate -or -not (Test-Path $candidate)) { continue }
      $control = Join-Path $candidate 'scripts\control-center-windows.ps1'
      if (Test-Path $control) { return [IO.Path]::GetFullPath($candidate) }
    } catch { }
  }
  throw 'No usable runtime slot is available for local Control Center recovery.'
}

function Start-RecoveryControlCenter([string]$Root = '') {
  if (-not $Root) { $Root = Get-RecoveryRoot }
  $control = Join-Path $Root 'scripts\control-center-windows.ps1'
  if (-not (Test-Path $control)) { throw "Control Center recovery script is missing: $control" }
  & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $control -Action Start -Root $Root -Json | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Control Center recovery start failed with exit code $LASTEXITCODE." }
}

$RecoveryStateRoot = Get-RecoveryRoot
$RecoveryStateScript = Join-Path $RecoveryStateRoot 'scripts\windows-recovery-state.ps1'
if (-not (Test-Path $RecoveryStateScript)) { throw "Recovery state helper is missing: $RecoveryStateScript" }
. $RecoveryStateScript
$LifecycleStateScript = Join-Path $RecoveryStateRoot 'scripts\windows-lifecycle-state.ps1'
if (-not (Test-Path $LifecycleStateScript)) { throw "Lifecycle state helper is missing: $LifecycleStateScript" }
. $LifecycleStateScript

function Get-RootVersion([string]$Root) {
  try {
    $manifest = Get-Content -Path (Join-Path $Root 'package.json') -Raw | ConvertFrom-Json
    return [string]$manifest.version
  } catch { return '' }
}

function Cleanup-VersionSlots {
  try {
    $versionsDir = Join-Path $Base 'versions'
    if (-not (Test-Path $versionsDir)) { return }
    $protected = @()
    foreach ($pointer in @($CurrentFile, $PreviousFile)) {
      if (-not (Test-Path $pointer)) { continue }
      $value = (Get-Content -Path $pointer -Raw).Trim()
      if ($value -and (Test-Path $value)) { $protected += [IO.Path]::GetFullPath($value) }
    }
    $extraKept = 0
    $dirs = @(Get-ChildItem -LiteralPath $versionsDir -Directory -ErrorAction SilentlyContinue | Sort-Object LastWriteTimeUtc -Descending)
    foreach ($dir in $dirs) {
      $full = [IO.Path]::GetFullPath($dir.FullName)
      $isProtected = $false
      foreach ($keep in $protected) {
        if ([string]::Equals($full, $keep, [StringComparison]::OrdinalIgnoreCase)) { $isProtected = $true; break }
      }
      if ($isProtected) { continue }
      # Keep one additional older slot besides current + previous for emergency
      # inspection while bounding long-term disk growth from automatic updates.
      if ($extraKept -lt 1) { $extraKept += 1; continue }
      Remove-Item -LiteralPath $full -Recurse -Force -ErrorAction Stop
    }
  } catch {
    Write-Warning "Old version-slot cleanup was skipped: $($_.Exception.Message)"
  }
}

function Invoke-Runtime([string]$RuntimeAction, [string]$Mode = 'OpenAI', [string]$Root = '') {
  if (-not $Root) { $Root = Get-CurrentRoot }
  $script = Join-Path $Root 'scripts\runtime-control-windows.ps1'
  if ($RuntimeAction -in @('Start','Restart','RegisterStartup')) {
    & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $script -Action $RuntimeAction -Mode $Mode -Root $Root
  } else {
    & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $script -Action $RuntimeAction -Root $Root
  }
  if ($LASTEXITCODE -ne 0) { throw "Runtime action $RuntimeAction failed with exit code $LASTEXITCODE." }
}

function Invoke-Updater([string]$UpdateAction, [switch]$Quiet) {
  if (-not (Test-Path $Updater)) { return }
  $args = @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',$Updater,'-Action',$UpdateAction)
  if ($Quiet) { $args += '-Quiet' }
  & powershell.exe @args
  if ($LASTEXITCODE -ne 0) { throw "Updater action $UpdateAction failed with exit code $LASTEXITCODE." }
}

function Invoke-SafeBoot {
  $bootTx = $null
  $bootOwned = $false
  $bootOutcome = 'FAILED'
  $bootMessage = 'safe boot did not complete'
  if (-not (Test-RwmcpLifecycleTransactionActive)) {
    $bootTx = Begin-RwmcpLifecycleTransaction -Kind boot -LeaseSeconds 600 -Message 'safe boot'
    $bootOwned = [int]$bootTx.ownerPid -eq $PID
  }
  try {
  $recoveryRoot = Get-RecoveryRoot
  $desiredBefore = Get-RwmcpDesiredState
  $explicitStop = $desiredBefore.reason -ne 'not-configured' -and -not [bool]$desiredBefore.desiredRunning
  if (-not $explicitStop) {
    Set-RwmcpDesiredState -DesiredRunning $true -Mode OpenAI -Reason 'boot' | Out-Null
  }
  Set-RwmcpRecoveryMaintenance -Seconds 300 -Reason 'boot-maintenance' -Mode OpenAI | Out-Null
  try {
    Start-RecoveryControlCenter $recoveryRoot
  } catch {
    Write-Warning "Local Control Center recovery start failed; continuing boot recovery: $($_.Exception.Message)"
  }

  $before = Get-CurrentRoot
  try {
    Invoke-Updater 'InstallAuto' -Quiet
  } catch {
    Write-Warning "Automatic update check failed; continuing with the installed version: $($_.Exception.Message)"
  }
  $candidate = Get-CurrentRoot
  if ($explicitStop) {
    Clear-RwmcpRecoveryMaintenance -Reason 'boot-owner-stop-preserved' | Out-Null
    Cleanup-VersionSlots
    $bootOutcome = 'SUCCEEDED'
    $bootMessage = 'safe boot preserved owner stop'
    return
  }
  try {
    Invoke-Runtime 'Start' 'OpenAI' $candidate
    Cleanup-VersionSlots
  } catch {
    if (-not [string]::Equals($candidate, $before, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path $PreviousFile)) {
      $failedVersion = Get-RootVersion $candidate
      if ($failedVersion -and (Test-Path $Updater)) {
        try { & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $Updater -Action MarkFailed -Version $failedVersion -Quiet | Out-Null } catch {}
      }
      Write-Warning "Updated runtime failed health/readiness checks. Rolling back to the previous slot."
      & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $Installer -Rollback -NoSetup
      if ($LASTEXITCODE -ne 0) { throw 'Automatic rollback failed.' }
      Invoke-Runtime 'Start' 'OpenAI' (Get-CurrentRoot)
      return
    }
    throw
  }
  $bootOutcome = 'SUCCEEDED'
  $bootMessage = 'safe boot complete'
  } catch {
    $bootMessage = $_.Exception.Message
    throw
  } finally {
    if ($bootOwned -and $bootTx) { Complete-RwmcpLifecycleTransaction -Epoch ([int64]$bootTx.epoch) -Outcome $bootOutcome -Message $bootMessage | Out-Null }
  }
}

$Root = if ($Action -in @('Boot','Setup')) { Get-RecoveryRoot } else { Get-CurrentRoot }
switch ($Action) {
  'Setup' { & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root 'scripts\setup-web-windows.ps1') }
  'Start' { Invoke-Runtime 'Start' 'Local' $Root }
  'StartOpenAI' { Invoke-Runtime 'Start' 'OpenAI' $Root }
  'Boot' { Invoke-SafeBoot }
  'Stop' { Invoke-Runtime 'Stop' 'OpenAI' $Root }
  'Restart' {
    $safeRestart = Join-Path $Root 'scripts\safe-restart-windows.ps1'
    & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $safeRestart -Root $Root -Mode OpenAI
    if ($LASTEXITCODE -ne 0) { throw "Safe runtime restart failed with exit code $LASTEXITCODE." }
  }
  'Status' { Invoke-Runtime 'Status' 'OpenAI' $Root }
  'AutostartOn' { Invoke-Runtime 'RegisterStartup' 'OpenAI' $Root }
  'AutostartOff' { Invoke-Runtime 'UnregisterStartup' 'OpenAI' $Root }
  'UpdateCheck' { Invoke-Updater 'Check' }
  'AutoUpdateOn' { Invoke-Updater 'Enable' }
  'AutoUpdateOff' { Invoke-Updater 'Disable' }
  'Update' {
    $updateTx = $null
    $updateOwned = $false
    $updateOutcome = 'FAILED'
    $updateMessage = 'update did not complete'
    if (-not (Test-RwmcpLifecycleTransactionActive)) {
      $updateTx = Begin-RwmcpLifecycleTransaction -Kind update -LeaseSeconds 900 -Message 'manual update'
      $updateOwned = [int]$updateTx.ownerPid -eq $PID
    }
    try {
    $before = Get-CurrentRoot
    $desiredBefore = Get-RwmcpDesiredState
    Set-RwmcpRecoveryMaintenance -Seconds 600 -Reason 'update-maintenance' -Mode OpenAI | Out-Null
    try { Start-RecoveryControlCenter (Get-RecoveryRoot) } catch { Write-Warning "Control Center recovery start before update failed: $($_.Exception.Message)" }
    $savedPreserve = $env:RWMCP_RECOVERY_PRESERVE_DESIRED
    $env:RWMCP_RECOVERY_PRESERVE_DESIRED = '1'
    try { Invoke-Runtime 'Stop' 'OpenAI' $before } catch {} finally {
      if ($null -eq $savedPreserve) { Remove-Item Env:RWMCP_RECOVERY_PRESERVE_DESIRED -ErrorAction SilentlyContinue }
      else { $env:RWMCP_RECOVERY_PRESERVE_DESIRED = $savedPreserve }
    }
    Invoke-Updater 'Install'
    $candidate = Get-CurrentRoot
    if (-not [bool]$desiredBefore.desiredRunning -and $desiredBefore.reason -ne 'not-configured') {
      Clear-RwmcpRecoveryMaintenance -Reason 'update-complete-owner-stop-preserved' | Out-Null
      Cleanup-VersionSlots
      $updateOutcome = 'SUCCEEDED'
      $updateMessage = 'update complete; owner stop preserved'
      return
    }
    try {
      Invoke-Runtime 'Start' 'OpenAI' $candidate
      Cleanup-VersionSlots
    } catch {
      $failedVersion = Get-RootVersion $candidate
      if ($failedVersion -and (Test-Path $Updater)) {
        try { & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $Updater -Action MarkFailed -Version $failedVersion -Quiet | Out-Null } catch {}
      }
      if (Test-Path $PreviousFile) {
        & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $Installer -Rollback -NoSetup
        if ($LASTEXITCODE -eq 0) { Invoke-Runtime 'Start' 'OpenAI' (Get-CurrentRoot) }
      }
      throw
    }
    $updateOutcome = 'SUCCEEDED'
    $updateMessage = 'update complete'
    } catch {
      $updateMessage = $_.Exception.Message
      throw
    } finally {
      if ($updateOwned -and $updateTx) { Complete-RwmcpLifecycleTransaction -Epoch ([int64]$updateTx.epoch) -Outcome $updateOutcome -Message $updateMessage | Out-Null }
    }
  }
  'Rollback' {
    $rollbackTx = $null
    $rollbackOwned = $false
    $rollbackOutcome = 'FAILED'
    $rollbackMessage = 'rollback did not complete'
    if (-not (Test-RwmcpLifecycleTransactionActive)) {
      $rollbackTx = Begin-RwmcpLifecycleTransaction -Kind rollback -LeaseSeconds 600 -Message 'rollback'
      $rollbackOwned = [int]$rollbackTx.ownerPid -eq $PID
    }
    try {
    $desiredBefore = Get-RwmcpDesiredState
    Set-RwmcpRecoveryMaintenance -Seconds 300 -Reason 'rollback-maintenance' -Mode OpenAI | Out-Null
    try { Start-RecoveryControlCenter (Get-RecoveryRoot) } catch { Write-Warning "Control Center recovery start before rollback failed: $($_.Exception.Message)" }
    $savedPreserve = $env:RWMCP_RECOVERY_PRESERVE_DESIRED
    $env:RWMCP_RECOVERY_PRESERVE_DESIRED = '1'
    try { Invoke-Runtime 'Stop' 'OpenAI' $Root } catch {} finally {
      if ($null -eq $savedPreserve) { Remove-Item Env:RWMCP_RECOVERY_PRESERVE_DESIRED -ErrorAction SilentlyContinue }
      else { $env:RWMCP_RECOVERY_PRESERVE_DESIRED = $savedPreserve }
    }
    & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $Installer -Rollback -NoSetup
    if ($LASTEXITCODE -ne 0) { throw 'Rollback failed.' }
    if ([bool]$desiredBefore.desiredRunning -or $desiredBefore.reason -eq 'not-configured') {
      Invoke-Runtime 'Start' 'OpenAI' (Get-CurrentRoot)
    } else {
      Clear-RwmcpRecoveryMaintenance -Reason 'rollback-complete-owner-stop-preserved' | Out-Null
    }
    $rollbackOutcome = 'SUCCEEDED'
    $rollbackMessage = 'rollback complete'
    } catch {
      $rollbackMessage = $_.Exception.Message
      throw
    } finally {
      if ($rollbackOwned -and $rollbackTx) { Complete-RwmcpLifecycleTransaction -Epoch ([int64]$rollbackTx.epoch) -Outcome $rollbackOutcome -Message $rollbackMessage | Out-Null }
    }
  }
}
