param(
  [ValidateSet('Check','Install','InstallAuto','Enable','Disable','Status','MarkFailed')]
  [string]$Action = 'Status',
  [string]$Version = '',
  [switch]$Json,
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Repo = 'Tunglam0605/remote-workstation-mcp'
$LocalBase = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $HOME 'AppData\Local' }
$Base = Join-Path $LocalBase 'RemoteWorkstationMCP'
$BinDir = Join-Path $Base 'bin'
$CurrentFile = Join-Path $Base 'current.txt'
$UpdatePath = Join-Path $Base 'update.json'
$InstallerPath = Join-Path $BinDir 'install-windows-release.ps1'
$DefaultRetryHours = 24
New-Item -ItemType Directory -Force -Path $Base, $BinDir | Out-Null

function New-DefaultState {
  return [ordered]@{
    version = 1
    enabled = $true
    channel = 'stable'
    automaticPolicy = 'patch'
    checkOnStartup = $true
    checkIntervalHours = 12
    retryFailedAfterHours = $DefaultRetryHours
    lastCheckAt = $null
    lastInstalledVersion = $null
    failedVersion = $null
    failedAt = $null
    retryAfter = $null
  }
}

function Read-State {
  if (-not (Test-Path $UpdatePath)) { return [pscustomobject](New-DefaultState) }
  try {
    $state = Get-Content -Path $UpdatePath -Raw | ConvertFrom-Json
  } catch {
    throw "Failed to read update settings at ${UpdatePath}: $($_.Exception.Message)"
  }
  $defaults = New-DefaultState
  foreach ($name in $defaults.Keys) {
    if (-not ($state.PSObject.Properties.Name -contains $name)) {
      $state | Add-Member -NotePropertyName $name -NotePropertyValue $defaults[$name]
    }
  }
  return $state
}

function Write-State($State) {
  $json = $State | ConvertTo-Json -Depth 6
  [IO.File]::WriteAllText($UpdatePath, $json + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
}

function Get-InstalledVersion {
  if (-not (Test-Path $CurrentFile)) { return $null }
  try {
    $root = (Get-Content -Path $CurrentFile -Raw).Trim()
    if (-not $root) { return $null }
    $manifestPath = Join-Path $root 'package.json'
    if (-not (Test-Path $manifestPath)) { return $null }
    $manifest = Get-Content -Path $manifestPath -Raw | ConvertFrom-Json
    return [string]$manifest.version
  } catch {
    return $null
  }
}

function Get-LatestStableRelease {
  $headers = @{ 'User-Agent' = 'remote-workstation-mcp-windows-updater'; 'Accept' = 'application/vnd.github+json' }
  $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers $headers -UseBasicParsing -TimeoutSec 15
  $tag = [string]$release.tag_name
  if ($tag -notmatch '^v(\d+)\.(\d+)\.(\d+)$') { throw "Unexpected stable release tag: $tag" }
  return [pscustomobject]@{
    tag = $tag
    version = $tag.Substring(1)
    url = [string]$release.html_url
  }
}

function Compare-Version([string]$Left, [string]$Right) {
  try {
    $a = [version]$Left
    $b = [version]$Right
    return $a.CompareTo($b)
  } catch {
    throw "Invalid semantic version comparison: '$Left' vs '$Right'."
  }
}

function Test-PatchUpgrade([string]$Current, [string]$Target) {
  try {
    $currentVersion = [version]$Current
    $targetVersion = [version]$Target
    return (
      $targetVersion.Major -eq $currentVersion.Major -and
      $targetVersion.Minor -eq $currentVersion.Minor -and
      $targetVersion.Build -gt $currentVersion.Build
    )
  } catch {
    throw "Invalid semantic version comparison: '$Current' vs '$Target'."
  }
}

function Get-UpdateKind([string]$Current, [string]$Target) {
  if (-not $Current -or -not $Target -or (Compare-Version $Target $Current) -le 0) { return $null }
  $currentVersion = [version]$Current
  $targetVersion = [version]$Target
  if ($targetVersion.Major -ne $currentVersion.Major) { return 'major' }
  if ($targetVersion.Minor -ne $currentVersion.Minor) { return 'minor' }
  return 'patch'
}

function Test-RetryBlocked($State, [string]$LatestVersion) {
  if (-not $State.failedVersion -or [string]$State.failedVersion -ne $LatestVersion) { return $false }
  if (-not $State.retryAfter) { return $false }
  try { return [DateTimeOffset]::Parse([string]$State.retryAfter) -gt [DateTimeOffset]::UtcNow }
  catch { return $false }
}


function Test-AutoCheckDue($State) {
  if (-not $State.lastCheckAt) { return $true }
  try {
    $last = [DateTimeOffset]::Parse([string]$State.lastCheckAt)
    $hours = [Math]::Max(1, [int]$State.checkIntervalHours)
    return $last.AddHours($hours) -le [DateTimeOffset]::UtcNow
  } catch { return $true }
}

function Get-StatusObject($State, $Latest = $null) {
  $installed = Get-InstalledVersion
  $latestVersion = if ($Latest) { [string]$Latest.version } else { $null }
  $available = $false
  if ($installed -and $latestVersion) { $available = (Compare-Version $latestVersion $installed) -gt 0 }
  elseif (-not $installed -and $latestVersion) { $available = $true }
  $updateKind = if ($installed -and $latestVersion) { Get-UpdateKind $installed $latestVersion } else { $null }
  $automaticAllowed = [bool]$State.enabled -and $updateKind -eq 'patch'
  return [pscustomobject]@{
    enabled = [bool]$State.enabled
    channel = [string]$State.channel
    automaticPolicy = 'patch'
    checkOnStartup = [bool]$State.checkOnStartup
    checkIntervalHours = [int]$State.checkIntervalHours
    installedVersion = $installed
    latestVersion = $latestVersion
    updateAvailable = $available
    updateKind = $updateKind
    automaticInstallAllowed = $automaticAllowed
    lastCheckAt = $State.lastCheckAt
    lastInstalledVersion = $State.lastInstalledVersion
    failedVersion = $State.failedVersion
    failedAt = $State.failedAt
    retryAfter = $State.retryAfter
    settingsPath = $UpdatePath
  }
}

function Emit($Value) {
  if ($Json) { $Value | ConvertTo-Json -Depth 6 -Compress }
  elseif (-not $Quiet) { $Value | Format-List }
}

$state = Read-State

switch ($Action) {
  'Enable' {
    $state.enabled = $true
    $state.channel = 'stable'
    $state.checkOnStartup = $true
    Write-State $state
    Emit (Get-StatusObject $state)
    exit 0
  }
  'Disable' {
    $state.enabled = $false
    Write-State $state
    Emit (Get-StatusObject $state)
    exit 0
  }
  'Status' {
    Emit (Get-StatusObject $state)
    exit 0
  }
  'MarkFailed' {
    if ([string]::IsNullOrWhiteSpace($Version)) { throw '-Version is required for MarkFailed.' }
    $failed = $Version.TrimStart('v')
    $now = [DateTimeOffset]::UtcNow
    $hours = [Math]::Max(1, [int]$state.retryFailedAfterHours)
    $state.failedVersion = $failed
    $state.failedAt = $now.ToString('o')
    $state.retryAfter = $now.AddHours($hours).ToString('o')
    Write-State $state
    Emit (Get-StatusObject $state)
    exit 0
  }
}

# Serialize release checks/installs across duplicate logon launches or a manual
# update racing an automatic Boot check. A named current-session mutex is enough
# because all managed Windows operations run as the signed-in owner.
$updateMutex = New-Object System.Threading.Mutex($false, 'Local\RemoteWorkstationMCP.Update')
$updateLockAcquired = $false
try {
  try {
    $updateLockAcquired = $updateMutex.WaitOne(0)
  } catch [System.Threading.AbandonedMutexException] {
    $updateLockAcquired = $true
  }
  if (-not $updateLockAcquired) {
    if ($Action -eq 'InstallAuto') {
      if (-not $Quiet) { Write-Host 'Another Remote Workstation update operation is already running; skipping this automatic check.' -ForegroundColor Yellow }
      Emit (Get-StatusObject $state)
      exit 0
    }
    throw 'Another Remote Workstation update operation is already running.'
  }
} catch {
  $updateMutex.Dispose()
  throw
}

if ([string]$state.channel -ne 'stable') { throw "Unsupported Windows update channel '$($state.channel)'." }
if ($Action -eq 'InstallAuto' -and -not (Test-AutoCheckDue $state)) {
  Emit (Get-StatusObject $state)
  exit 0
}

$latest = Get-LatestStableRelease
$state.lastCheckAt = [DateTimeOffset]::UtcNow.ToString('o')
Write-State $state
$status = Get-StatusObject $state $latest

if ($Action -eq 'Check') {
  Emit $status
  exit 0
}

if (-not $status.updateAvailable) {
  if (-not $Quiet) { Write-Host "Remote Workstation MCP is up to date (v$($status.installedVersion))." -ForegroundColor Green }
  Emit $status
  exit 0
}

if ($Action -eq 'InstallAuto') {
  if (-not [bool]$state.enabled) {
    if (-not $Quiet) { Write-Host "Update v$($latest.version) is available; automatic patch updates are disabled, so owner approval is required." -ForegroundColor Yellow }
    Emit $status
    exit 0
  }
  if (-not (Test-PatchUpgrade ([string]$status.installedVersion) ([string]$latest.version))) {
    if (-not $Quiet) { Write-Host "Update v$($latest.version) is a $($status.updateKind) release; automatic policy installs patch releases only. Owner approval is required." -ForegroundColor Yellow }
    Emit $status
    exit 0
  }
}

if (Test-RetryBlocked $state ([string]$latest.version)) {
  if (-not $Quiet) { Write-Host "Skipping v$($latest.version) until $($state.retryAfter) because the previous activation failed." -ForegroundColor Yellow }
  Emit (Get-StatusObject $state $latest)
  exit 0
}

if (-not (Test-Path $InstallerPath)) { throw "Stable Windows installer is missing: $InstallerPath" }
if (-not $Quiet) { Write-Host "Installing stable update v$($latest.version)..." -ForegroundColor Cyan }
& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $InstallerPath -Version ([string]$latest.version) -NoSetup -SkipPrerequisites
if ($LASTEXITCODE -ne 0) { throw "Windows release installer failed with exit code $LASTEXITCODE." }

$state = Read-State
$state.lastInstalledVersion = [string]$latest.version
if ([string]$state.failedVersion -eq [string]$latest.version) {
  $state.failedVersion = $null
  $state.failedAt = $null
  $state.retryAfter = $null
}
Write-State $state
Emit (Get-StatusObject $state $latest)
