Set-StrictMode -Version Latest

if (-not (Get-Command Get-RwmcpUserConfigDir -ErrorAction SilentlyContinue)) {
  . (Join-Path $PSScriptRoot 'windows-settings.ps1')
}

function Get-RwmcpLifecycleStatePath {
  return Join-Path (Get-RwmcpUserConfigDir) 'runtime\lifecycle-state.json'
}


function Get-RwmcpLifecycleLockPath {
  return Join-Path (Get-RwmcpUserConfigDir) 'runtime\lifecycle-state.lock'
}

function Acquire-RwmcpLifecycleLock {
  $path = Get-RwmcpLifecycleLockPath
  $dir = Split-Path -Parent $path
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds(15)
  while ([DateTimeOffset]::UtcNow -lt $deadline) {
    try { return [IO.File]::Open($path, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
    catch [IO.IOException] { Start-Sleep -Milliseconds 100 }
  }
  throw "Timed out waiting for lifecycle state lock: $path"
}

function Release-RwmcpLifecycleLock($Handle) {
  if ($null -ne $Handle) { try { $Handle.Dispose() } catch {} }
}

function New-RwmcpDefaultLifecycleState {
  return [pscustomobject]@{
    version = 1
    epoch = 0
    state = 'IDLE'
    kind = 'none'
    ownerPid = $null
    ownerStartedAt = $null
    leaseUntil = $null
    startedAt = $null
    updatedAt = [DateTimeOffset]::UtcNow.ToString('o')
    message = 'not-configured'
  }
}

function Get-RwmcpLifecycleState {
  $path = Get-RwmcpLifecycleStatePath
  if (-not (Test-Path -LiteralPath $path)) { return New-RwmcpDefaultLifecycleState }
  try {
    $state = Get-Content -LiteralPath $path -Raw -ErrorAction Stop | ConvertFrom-Json
    foreach ($name in @('version','epoch','state','kind','ownerPid','ownerStartedAt','leaseUntil','startedAt','updatedAt','message')) {
      if (-not ($state.PSObject.Properties.Name -contains $name)) { return New-RwmcpDefaultLifecycleState }
    }
    return $state
  } catch {
    return New-RwmcpDefaultLifecycleState
  }
}

function Write-RwmcpLifecycleState($State) {
  $path = Get-RwmcpLifecycleStatePath
  $dir = Split-Path -Parent $path
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $tmp = "$path.tmp.$PID"
  $json = $State | ConvertTo-Json -Depth 6
  [IO.File]::WriteAllText($tmp, $json + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $tmp -Destination $path -Force
  return Get-RwmcpLifecycleState
}

function Test-RwmcpLifecycleOwnerAlive($State) {
  if (-not $State -or [string]$State.state -ne 'RUNNING') { return $false }
  if ($null -eq $State.ownerPid -or -not $State.ownerStartedAt) { return $false }
  if ($State.leaseUntil) {
    try {
      if ([DateTimeOffset]::Parse([string]$State.leaseUntil) -le [DateTimeOffset]::UtcNow) { return $false }
    } catch { return $false }
  }
  try {
    $process = Get-Process -Id ([int]$State.ownerPid) -ErrorAction Stop
    $expected = [DateTimeOffset]::Parse([string]$State.ownerStartedAt).UtcDateTime
    return [Math]::Abs(($process.StartTime.ToUniversalTime() - $expected).TotalSeconds) -le 10
  } catch {
    return $false
  }
}

function Test-RwmcpLifecycleTransactionActive {
  $state = Get-RwmcpLifecycleState
  return Test-RwmcpLifecycleOwnerAlive $state
}

function Begin-RwmcpLifecycleTransaction {
  param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('boot','start','restart','update','rollback','recovery')]
    [string]$Kind,
    [ValidateRange(30,3600)][int]$LeaseSeconds = 900,
    [int]$OwnerPid = $PID,
    [string]$Message = ''
  )

  $lock = Acquire-RwmcpLifecycleLock
  try {
    $current = Get-RwmcpLifecycleState
    $active = Test-RwmcpLifecycleOwnerAlive $current
    if ($active) { return $current }

    try { $owner = Get-Process -Id $OwnerPid -ErrorAction Stop }
    catch { throw "Lifecycle owner PID $OwnerPid does not exist." }
    $now = [DateTimeOffset]::UtcNow
    $state = [ordered]@{
      version = 1
      epoch = ([int64]$current.epoch) + 1
      state = 'RUNNING'
      kind = $Kind
      ownerPid = $OwnerPid
      ownerStartedAt = ([DateTimeOffset]$owner.StartTime.ToUniversalTime()).ToString('o')
      leaseUntil = $now.AddSeconds($LeaseSeconds).ToString('o')
      startedAt = $now.ToString('o')
      updatedAt = $now.ToString('o')
      message = if ($Message) { $Message } else { "$Kind lifecycle transaction started" }
    }
    return Write-RwmcpLifecycleState ([pscustomobject]$state)
  } finally {
    Release-RwmcpLifecycleLock $lock
  }
}

function Complete-RwmcpLifecycleTransaction {
  param(
    [Parameter(Mandatory = $true)][int64]$Epoch,
    [ValidateSet('SUCCEEDED','FAILED','CANCELLED')][string]$Outcome = 'SUCCEEDED',
    [string]$Message = ''
  )
  $lock = Acquire-RwmcpLifecycleLock
  try {
    $current = Get-RwmcpLifecycleState
    if ([int64]$current.epoch -ne $Epoch) { return $current }
    if ([string]$current.state -ne 'RUNNING') { return $current }
    $state = [ordered]@{
      version = 1
      epoch = [int64]$current.epoch
      state = $Outcome
      kind = [string]$current.kind
      ownerPid = $null
      ownerStartedAt = $null
      leaseUntil = $null
      startedAt = $current.startedAt
      updatedAt = [DateTimeOffset]::UtcNow.ToString('o')
      message = if ($Message) { $Message } else { "$($current.kind) lifecycle transaction $($Outcome.ToLowerInvariant())" }
    }
    return Write-RwmcpLifecycleState ([pscustomobject]$state)
  } finally {
    Release-RwmcpLifecycleLock $lock
  }
}
