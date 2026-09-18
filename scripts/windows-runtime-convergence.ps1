Set-StrictMode -Version Latest

if (-not (Get-Command Get-RwmcpUserConfigDir -ErrorAction SilentlyContinue)) {
  . (Join-Path $PSScriptRoot 'windows-settings.ps1')
}

function Get-RwmcpManagedRuntimeBase {
  return [IO.Path]::GetFullPath((Get-RwmcpUserConfigDir))
}

function Write-RwmcpConvergenceLog([scriptblock]$Logger, [string]$Message) {
  if ($Logger) {
    try { & $Logger $Message } catch {}
  }
}

function Get-RwmcpManagedProcessEntries([string]$Needle) {
  $managedBase = Get-RwmcpManagedRuntimeBase
  try {
    return @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
      $line = [string]$_.CommandLine
      $line -and
        $line.IndexOf($managedBase, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
        $line.IndexOf($Needle, [StringComparison]::OrdinalIgnoreCase) -ge 0
    })
  } catch {
    return @()
  }
}

function Test-RwmcpProcessDescendant([int]$ProcessId, [int]$AncestorId) {
  $current = $ProcessId
  foreach ($depth in 1..32) {
    if ($current -eq $AncestorId) { return $true }
    try { $entry = Get-CimInstance Win32_Process -Filter "ProcessId=$current" -ErrorAction Stop }
    catch { return $false }
    if (-not $entry) { return $false }
    $parent = [int]$entry.ParentProcessId
    if ($parent -le 0 -or $parent -eq $current) { return $false }
    $current = $parent
  }
  return $false
}

function Stop-RwmcpManagedProcessTree {
  param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][string]$OwnershipNeedle,
    [scriptblock]$Logger = $null
  )

  $managedBase = Get-RwmcpManagedRuntimeBase
  try {
    $entry = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction Stop
    if (-not $entry) { return $false }
    $line = [string]$entry.CommandLine
    $owned = $line -and
      $line.IndexOf($managedBase, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
      $line.IndexOf($OwnershipNeedle, [StringComparison]::OrdinalIgnoreCase) -ge 0
    if (-not $owned) {
      Write-RwmcpConvergenceLog $Logger "Refusing to stop unverified process pid=$ProcessId needle=$OwnershipNeedle."
      return $false
    }
    if (Test-RwmcpProcessDescendant -ProcessId $PID -AncestorId $ProcessId) {
      throw "Refusing to stop managed process tree PID $ProcessId from one of its descendants."
    }

    $taskkill = Get-Command taskkill.exe -ErrorAction SilentlyContinue
    if ($taskkill) { & $taskkill.Source /PID $ProcessId /T /F *> $null }
    else { Stop-Process -Id $ProcessId -Force -ErrorAction Stop }
    Write-RwmcpConvergenceLog $Logger "Stopped managed process tree pid=$ProcessId ownership=$OwnershipNeedle."
    return $true
  } catch {
    Write-RwmcpConvergenceLog $Logger "Managed process cleanup failed pid=$($ProcessId): $($_.Exception.Message)"
    if ($_.Exception.Message -like 'Refusing to stop managed process tree*') { throw }
    return $false
  }
}

function Read-RwmcpRuntimeJson([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  try { return Get-Content -LiteralPath $Path -Raw -ErrorAction Stop | ConvertFrom-Json }
  catch { return $null }
}

function Get-RwmcpRecordedRuntimeHost([string]$SupervisorStatePath) {
  $state = Read-RwmcpRuntimeJson $SupervisorStatePath
  if (-not $state -or -not ($state.PSObject.Properties.Name -contains 'pid')) { return $null }
  try {
    $process = Get-Process -Id ([int]$state.pid) -ErrorAction Stop
    $entry = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$state.pid)" -ErrorAction Stop
    $line = [string]$entry.CommandLine
    $managedBase = Get-RwmcpManagedRuntimeBase
    if (-not $line -or
        $line.IndexOf($managedBase, [StringComparison]::OrdinalIgnoreCase) -lt 0 -or
        $line.IndexOf('runtime-host-windows.ps1', [StringComparison]::OrdinalIgnoreCase) -lt 0) {
      return $null
    }
    if ($state.PSObject.Properties.Name -contains 'startedAt') {
      $expected = [DateTimeOffset]::Parse([string]$state.startedAt).UtcDateTime
      if ([Math]::Abs(($process.StartTime.ToUniversalTime() - $expected).TotalSeconds) -gt 10) { return $null }
    }
    return $process
  } catch {
    return $null
  }
}

function Invoke-RwmcpRuntimeConvergence {
  param(
    [Parameter(Mandatory = $true)][string]$SupervisorStatePath,
    [Parameter(Mandatory = $true)][string]$ConnectionStatePath,
    [string]$TargetRoot = '',
    [scriptblock]$Logger = $null
  )

  $state = Read-RwmcpRuntimeJson $SupervisorStatePath
  $managed = Get-RwmcpRecordedRuntimeHost $SupervisorStatePath
  $runtimeHosts = @(Get-RwmcpManagedProcessEntries 'runtime-host-windows.ps1')

  if ($managed -and $TargetRoot -and $state -and ($state.PSObject.Properties.Name -contains 'root')) {
    $activeRoot = [IO.Path]::GetFullPath([string]$state.root)
    $targetFull = [IO.Path]::GetFullPath($TargetRoot)
    if (-not [string]::Equals($activeRoot, $targetFull, [StringComparison]::OrdinalIgnoreCase)) {
      Write-RwmcpConvergenceLog $Logger "Active runtime belongs to another slot root=$activeRoot target=$targetFull; stopping PID $($managed.Id)."
      [void](Stop-RwmcpManagedProcessTree -ProcessId ([int]$managed.Id) -OwnershipNeedle 'runtime-host-windows.ps1' -Logger $Logger)
      $managed = $null
      Remove-Item -LiteralPath $SupervisorStatePath, $ConnectionStatePath -Force -ErrorAction SilentlyContinue
    }
  }

  if ($state -and -not $managed) {
    Write-RwmcpConvergenceLog $Logger "Stale supervisor state detected; converging managed runtime processes."
    foreach ($hostEntry in $runtimeHosts) {
      [void](Stop-RwmcpManagedProcessTree -ProcessId ([int]$hostEntry.ProcessId) -OwnershipNeedle 'runtime-host-windows.ps1' -Logger $Logger)
    }
    Remove-Item -LiteralPath $SupervisorStatePath, $ConnectionStatePath -Force -ErrorAction SilentlyContinue
  }

  $managed = Get-RwmcpRecordedRuntimeHost $SupervisorStatePath
  $runtimeHosts = @(Get-RwmcpManagedProcessEntries 'runtime-host-windows.ps1')
  if ($managed) {
    foreach ($hostEntry in $runtimeHosts) {
      if ([int]$hostEntry.ProcessId -ne [int]$managed.Id) {
        Write-RwmcpConvergenceLog $Logger "Duplicate managed runtime host detected pid=$($hostEntry.ProcessId); active=$($managed.Id)."
        [void](Stop-RwmcpManagedProcessTree -ProcessId ([int]$hostEntry.ProcessId) -OwnershipNeedle 'runtime-host-windows.ps1' -Logger $Logger)
      }
    }
  } else {
    foreach ($hostEntry in $runtimeHosts) {
      [void](Stop-RwmcpManagedProcessTree -ProcessId ([int]$hostEntry.ProcessId) -OwnershipNeedle 'runtime-host-windows.ps1' -Logger $Logger)
    }
  }

  foreach ($needle in @('openai-tunnel-cli.js','dist\cli.js','tunnel-client.exe')) {
    foreach ($entry in @(Get-RwmcpManagedProcessEntries $needle)) {
      if ($managed -and (Test-RwmcpProcessDescendant -ProcessId ([int]$entry.ProcessId) -AncestorId ([int]$managed.Id))) {
        continue
      }
      Write-RwmcpConvergenceLog $Logger "Orphan managed runtime child detected pid=$($entry.ProcessId) needle=$needle."
      [void](Stop-RwmcpManagedProcessTree -ProcessId ([int]$entry.ProcessId) -OwnershipNeedle $needle -Logger $Logger)
    }
  }

  if (-not $managed) {
    Remove-Item -LiteralPath $SupervisorStatePath, $ConnectionStatePath -Force -ErrorAction SilentlyContinue
  }
  return $managed
}
