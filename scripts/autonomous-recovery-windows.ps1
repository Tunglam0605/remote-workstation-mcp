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
. (Join-Path $Root 'scripts\windows-runtime-convergence.ps1')

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
$CurrentPointerPath = Join-Path $ManagedBase 'current.txt'

function Get-CurrentManagedRoot {
  if (-not (Test-Path -LiteralPath $CurrentPointerPath)) { return $null }
  try {
    $value = (Get-Content -LiteralPath $CurrentPointerPath -Raw -ErrorAction Stop).Trim()
    if (-not $value) { return $null }
    return [IO.Path]::GetFullPath($value)
  } catch {
    return $null
  }
}

function Test-CurrentSlotOwnership {
  $currentRoot = Get-CurrentManagedRoot
  if (-not $currentRoot) { return $true }
  return [string]::Equals($currentRoot, $Root, [StringComparison]::OrdinalIgnoreCase)
}


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


function Invoke-RuntimeConvergence {
  return Invoke-RwmcpRuntimeConvergence `
    -SupervisorStatePath $SupervisorStatePath `
    -ConnectionStatePath $ConnectionStatePath `
    -Logger { param($Message) Append-RecoveryLog $Message }
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

if (-not (Test-CurrentSlotOwnership)) {
  $currentRoot = Get-CurrentManagedRoot
  Append-RecoveryLog "Autonomous recovery exiting because slot is no longer current root=$Root current=$currentRoot."
  Write-Output 'stale-slot-exit'
  exit 0
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
  if (-not (Test-CurrentSlotOwnership)) {
    $currentRoot = Get-CurrentManagedRoot
    Append-RecoveryLog "Autonomous recovery self-terminating after slot switch root=$Root current=$currentRoot."
    break
  }
  try {
    $result = Invoke-RecoveryEvaluation
    Write-RecoveryHeartbeat $result
  } catch {
    Append-RecoveryLog "Recovery evaluation error: $($_.Exception.Message)"
    Write-RecoveryHeartbeat 'error' $_.Exception.Message
  }
  Start-Sleep -Seconds $PollSeconds
}
