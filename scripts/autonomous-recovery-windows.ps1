param(
  [Parameter(Mandatory = $true)][string]$Root,
  [string]$LogPath = '',
  [ValidateRange(1,60)][int]$PollSeconds = 5,
  [switch]$OneShot
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$Root = (Resolve-Path $Root).Path
. (Join-Path $Root 'scripts\windows-settings.ps1')
. (Join-Path $Root 'scripts\windows-recovery-state.ps1')
. (Join-Path $Root 'scripts\windows-lifecycle-state.ps1')
. (Join-Path $Root 'scripts\windows-recovery-circuit.ps1')

$UserConfigDir = Get-RwmcpUserConfigDir
$ManagedBase = [IO.Path]::GetFullPath($UserConfigDir)
$RuntimeDir = Join-Path $UserConfigDir 'runtime'
$SupervisorStatePath = Join-Path $RuntimeDir 'supervisor.json'
$ConnectionStatePath = Join-Path $RuntimeDir 'connection-state.json'
$RecoveryStatePath = Join-Path $RuntimeDir 'recovery-supervisor-state.json'
$StableLauncher = Join-Path $UserConfigDir 'bin\rwmcp.ps1'
if (-not $LogPath) { $LogPath = Join-Path $RuntimeDir 'autonomous-recovery.log' }
New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null

$McpUnhealthySince = $null
$TunnelUnhealthySince = $null
$ActionProcess = $null

function Append-RecoveryLog([string]$Message) {
  "[$([DateTimeOffset]::UtcNow.ToString('o'))] $Message" | Add-Content -Path $LogPath -Encoding utf8
}

function Write-RecoveryHeartbeat([string]$Evaluation, [string]$ErrorMessage = '') {
  $payload = [ordered]@{
    version = 1
    pid = $PID
    root = $Root
    evaluation = $Evaluation
    error = if ($ErrorMessage) { $ErrorMessage } else { $null }
    updatedAt = [DateTimeOffset]::UtcNow.ToString('o')
  }
  $tmp = "$RecoveryStatePath.tmp"
  [IO.File]::WriteAllText($tmp, ($payload | ConvertTo-Json -Depth 4) + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $tmp -Destination $RecoveryStatePath -Force
}

function Read-JsonFile([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  try { return Get-Content -LiteralPath $Path -Raw -ErrorAction Stop | ConvertFrom-Json }
  catch { return $null }
}


function Get-ManagedProcessEntries([string]$Needle) {
  try {
    return @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
      $line = [string]$_.CommandLine
      $line -and $line.IndexOf($ManagedBase, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
        $line.IndexOf($Needle, [StringComparison]::OrdinalIgnoreCase) -ge 0
    })
  } catch {
    Append-RecoveryLog "Managed process discovery failed for '$Needle': $($_.Exception.Message)"
    return @()
  }
}

function Test-ProcessDescendant([int]$ProcessId, [int]$AncestorId) {
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

function Stop-ManagedProcessTree([int]$ProcessId, [string]$OwnershipNeedle) {
  try {
    $entry = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction Stop
    if (-not $entry) { return $false }
    $line = [string]$entry.CommandLine
    $owned = $line -and $line.IndexOf($ManagedBase, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
      $line.IndexOf($OwnershipNeedle, [StringComparison]::OrdinalIgnoreCase) -ge 0
    if (-not $owned) {
      Append-RecoveryLog "Refusing to stop unverified process pid=$ProcessId needle=$OwnershipNeedle."
      return $false
    }
    $taskkill = Get-Command taskkill.exe -ErrorAction SilentlyContinue
    if ($taskkill) { & $taskkill.Source /PID $ProcessId /T /F *> $null }
    else { Stop-Process -Id $ProcessId -Force -ErrorAction Stop }
    Append-RecoveryLog "Stopped managed process tree pid=$ProcessId ownership=$OwnershipNeedle."
    return $true
  } catch {
    Append-RecoveryLog "Managed process cleanup failed pid=${ProcessId}: $($_.Exception.Message)"
    return $false
  }
}

function Invoke-RuntimeConvergence {
  $state = Read-JsonFile $SupervisorStatePath
  $managed = Get-ManagedSupervisor
  $runtimeHosts = @(Get-ManagedProcessEntries 'runtime-host-windows.ps1')

  if ($state -and -not $managed) {
    Append-RecoveryLog "stale-supervisor-state pid=$($state.pid); converging managed runtime hosts."
    foreach ($hostEntry in $runtimeHosts) {
      [void](Stop-ManagedProcessTree ([int]$hostEntry.ProcessId) 'runtime-host-windows.ps1')
    }
    foreach ($tunnelEntry in @(Get-ManagedProcessEntries 'tunnel-client.exe')) {
      [void](Stop-ManagedProcessTree ([int]$tunnelEntry.ProcessId) 'tunnel-client.exe')
    }
    Remove-Item -LiteralPath $SupervisorStatePath, $ConnectionStatePath -Force -ErrorAction SilentlyContinue
    return $null
  }

  if ($managed) {
    foreach ($hostEntry in $runtimeHosts) {
      if ([int]$hostEntry.ProcessId -ne [int]$managed.Id) {
        Append-RecoveryLog "Duplicate managed runtime host detected pid=$($hostEntry.ProcessId); active=$($managed.Id)."
        [void](Stop-ManagedProcessTree ([int]$hostEntry.ProcessId) 'runtime-host-windows.ps1')
      }
    }
    foreach ($tunnelEntry in @(Get-ManagedProcessEntries 'tunnel-client.exe')) {
      if (-not (Test-ProcessDescendant ([int]$tunnelEntry.ProcessId) ([int]$managed.Id))) {
        Append-RecoveryLog "Orphan managed tunnel detected pid=$($tunnelEntry.ProcessId); active-supervisor=$($managed.Id)."
        [void](Stop-ManagedProcessTree ([int]$tunnelEntry.ProcessId) 'tunnel-client.exe')
      }
    }
  }
  return $managed
}

function Get-ManagedSupervisor {
  $state = Read-JsonFile $SupervisorStatePath
  if (-not $state -or -not ($state.PSObject.Properties.Name -contains 'pid')) { return $null }
  try {
    $process = Get-Process -Id ([int]$state.pid) -ErrorAction Stop
    $entry = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$state.pid)" -ErrorAction Stop
    $line = [string]$entry.CommandLine
    if (-not $line -or $line.IndexOf($ManagedBase, [StringComparison]::OrdinalIgnoreCase) -lt 0 -or $line.IndexOf('runtime-host-windows.ps1', [StringComparison]::OrdinalIgnoreCase) -lt 0) { return $null }
    if ($state.PSObject.Properties.Name -contains 'startedAt') {
      $expected = [DateTimeOffset]::Parse([string]$state.startedAt).UtcDateTime
      if ([Math]::Abs(($process.StartTime.ToUniversalTime() - $expected).TotalSeconds) -gt 10) { return $null }
    }
    return $process
  } catch { return $null }
}

function Test-McpHealthy {
  $port = 8683
  $state = Read-JsonFile $SupervisorStatePath
  if ($state -and ($state.PSObject.Properties.Name -contains 'port')) { $port = [int]$state.port }
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/healthz" -TimeoutSec 2
    return $health.ok -eq $true
  } catch { return $false }
}

function Get-ConnectionHealth {
  $connection = Read-JsonFile $ConnectionStatePath
  if (-not $connection) { return [pscustomobject]@{ online = $false; ageSeconds = [double]::PositiveInfinity; reason = 'missing' } }
  $age = [double]::PositiveInfinity
  try { $age = ([DateTimeOffset]::UtcNow - [DateTimeOffset]::Parse([string]$connection.updatedAt)).TotalSeconds } catch {}
  return [pscustomobject]@{
    online = ([string]$connection.state -eq 'ONLINE') -and $age -le 30
    ageSeconds = $age
    reason = [string]$connection.reason
  }
}

function Recovery-ActionAvailable {
  if ($ActionProcess) {
    try { $ActionProcess.Refresh() } catch {}
    if (-not $ActionProcess.HasExited) { return $false }
    Append-RecoveryLog "Recovery action process pid=$($ActionProcess.Id) exited code=$($ActionProcess.ExitCode)."
    $script:ActionProcess = $null
  }
  return Test-RwmcpRecoveryCircuitAllowsAction
}

function Start-RecoveryAction([string]$Action, [string]$Reason) {
  if (-not (Recovery-ActionAvailable)) { return $false }
  if (-not (Test-Path -LiteralPath $StableLauncher)) {
    [void](Register-RwmcpRecoveryFailure -Reason "launcher-missing:$Reason")
    Append-RecoveryLog "Stable launcher missing; cannot recover: $StableLauncher"
    return $false
  }
  $powershell = (Get-Command powershell.exe -ErrorAction Stop).Source
  $argumentLine = @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$StableLauncher`"",'-Action',$Action) -join ' '
  $script:ActionProcess = Start-Process -FilePath $powershell -ArgumentList $argumentLine -WindowStyle Hidden -PassThru
  $circuit = Register-RwmcpRecoveryFailure -Reason $Reason
  Append-RecoveryLog "Recovery action=$Action reason=$Reason pid=$($ActionProcess.Id) failureCount=$($circuit.failureCount) cooldownUntil=$($circuit.cooldownUntil) openUntil=$($circuit.openUntil)."
  if ($OneShot) {
    try { [void]$ActionProcess.WaitForExit(10000) } catch {}
  }
  return $true
}

function Reset-RecoveryHealth([switch]$ResetCircuit) {
  $script:McpUnhealthySince = $null
  $script:TunnelUnhealthySince = $null
  if ($ResetCircuit) { [void](Reset-RwmcpRecoveryCircuit -Reason 'healthy') }
}

function Invoke-RecoveryEvaluation {
  $desired = Get-RwmcpDesiredState
  if (-not [bool]$desired.desiredRunning) {
    Reset-RecoveryHealth -ResetCircuit
    return 'suppressed-owner-stop'
  }
  if (Test-RwmcpRecoveryMaintenanceActive) {
    $script:McpUnhealthySince = $null
    $script:TunnelUnhealthySince = $null
    return 'suppressed-maintenance'
  }
  if (Test-RwmcpLifecycleTransactionActive) {
    $script:McpUnhealthySince = $null
    $script:TunnelUnhealthySince = $null
    return 'suppressed-lifecycle'
  }

  $managed = Invoke-RuntimeConvergence
  if (-not $managed) {
    $action = if ([string]$desired.mode -eq 'Local') { 'Start' } else { 'StartOpenAI' }
    if (Start-RecoveryAction $action 'runtime-supervisor-missing') { return 'start-requested' }
    return 'start-backoff'
  }

  $mcpHealthy = Test-McpHealthy
  if (-not $mcpHealthy) {
    if ($null -eq $McpUnhealthySince) { $script:McpUnhealthySince = [DateTimeOffset]::UtcNow }
    $age = ([DateTimeOffset]::UtcNow - $McpUnhealthySince).TotalSeconds
    if ($age -ge 15 -and (Start-RecoveryAction 'Restart' 'mcp-health-stale')) { return 'restart-mcp-requested' }
    return 'waiting-mcp-health'
  }
  $script:McpUnhealthySince = $null

  if ([string]$desired.mode -eq 'OpenAI') {
    $connection = Get-ConnectionHealth
    if (-not $connection.online) {
      if ($null -eq $TunnelUnhealthySince) { $script:TunnelUnhealthySince = [DateTimeOffset]::UtcNow }
      $age = ([DateTimeOffset]::UtcNow - $TunnelUnhealthySince).TotalSeconds
      if ($age -ge 90 -and (Start-RecoveryAction 'Restart' "tunnel-stale:$($connection.reason)")) { return 'restart-tunnel-requested' }
      return 'waiting-tunnel-health'
    }
  }

  Reset-RecoveryHealth -ResetCircuit
  return 'healthy'
}

if ($OneShot) {
  try {
    $result = Invoke-RecoveryEvaluation
    Write-RecoveryHeartbeat $result
    Write-Output $result
    exit 0
  } catch {
    Write-RecoveryHeartbeat 'error' $_.Exception.Message
    throw
  }
}

Append-RecoveryLog "Autonomous recovery supervisor started root=$Root poll=${PollSeconds}s."
while ($true) {
  try {
    $result = Invoke-RecoveryEvaluation
    Write-RecoveryHeartbeat $result
  } catch {
    Append-RecoveryLog "Recovery evaluation error: $($_.Exception.Message)"
    Write-RecoveryHeartbeat 'error' $_.Exception.Message
  }
  Start-Sleep -Seconds $PollSeconds
}
