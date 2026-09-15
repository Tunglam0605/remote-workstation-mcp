param(
  [ValidateSet('Start','Stop','Restart','Status','Open')]
  [string]$Action = 'Status',
  [string]$Root = '',
  [switch]$Json
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ([string]::IsNullOrWhiteSpace($Root)) {
  $Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
} else {
  $Root = (Resolve-Path $Root).Path
}

. (Join-Path $Root 'scripts\windows-settings.ps1')

$UserConfigDir = Get-RwmcpUserConfigDir
$StateDir = Join-Path $UserConfigDir 'runtime'
$StatePath = Join-Path $StateDir 'control-center.json'
$StdoutLog = Join-Path $StateDir 'control-center.stdout.log'
$StderrLog = Join-Path $StateDir 'control-center.stderr.log'
New-Item -ItemType Directory -Force -Path $StateDir | Out-Null

function Read-State {
  if (-not (Test-Path $StatePath)) { return $null }
  try { return Get-Content -Path $StatePath -Raw | ConvertFrom-Json }
  catch { return $null }
}

function Get-ManagedProcess($state) {
  if (-not $state) { return $null }
  foreach ($name in @('pid','processPath','startedAt','root','port')) {
    if (-not ($state.PSObject.Properties.Name -contains $name)) { return $null }
  }
  try {
    $process = Get-Process -Id ([int]$state.pid) -ErrorAction Stop
    $actualPath = [IO.Path]::GetFullPath([string]$process.Path)
    $expectedPath = [IO.Path]::GetFullPath([string]$state.processPath)
    if (-not [string]::Equals($actualPath, $expectedPath, [StringComparison]::OrdinalIgnoreCase)) { return $null }
    $expectedStarted = [DateTimeOffset]::Parse([string]$state.startedAt).UtcDateTime
    if ([Math]::Abs(($process.StartTime.ToUniversalTime() - $expectedStarted).TotalSeconds) -gt 10) { return $null }
    return $process
  } catch { return $null }
}

function Stop-ProcessTree([int]$rootProcessId) {
  $taskkill = Get-Command taskkill.exe -ErrorAction SilentlyContinue
  if (-not $taskkill) {
    Stop-Process -Id $rootProcessId -Force -ErrorAction SilentlyContinue
    return
  }
  & $taskkill.Source /PID $rootProcessId /T /F *> $null
}

function Get-LoopbackListenerOwner([int]$port) {
  try {
    $listener = Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $port -State Listen -ErrorAction Stop | Select-Object -First 1
    if ($listener) { return [int]$listener.OwningProcess }
  } catch {}
  return $null
}

function Test-ProcessDescendant([int]$processId, [int]$ancestorId) {
  $current = $processId
  foreach ($depth in 1..16) {
    if ($current -eq $ancestorId) { return $true }
    try {
      $entry = Get-CimInstance Win32_Process -Filter "ProcessId=$current" -ErrorAction Stop
    } catch { return $false }
    if (-not $entry) { return $false }
    $parent = [int]$entry.ParentProcessId
    if ($parent -le 0 -or $parent -eq $current) { return $false }
    $current = $parent
  }
  return $false
}

function Apply-ControlEnvironment {
  Apply-RwmcpPersistedEnvironment -Root $Root | Out-Null
  $externalConfigDir = Join-Path $UserConfigDir 'config'
  if (-not $env:RWMCP_POLICY) { $env:RWMCP_POLICY = Join-Path $externalConfigDir 'policy.yaml' }
  if (-not $env:RWMCP_HOSTS) { $env:RWMCP_HOSTS = Join-Path $externalConfigDir 'hosts.yaml' }
  if (-not $env:RWMCP_SETUP_PORT) { $env:RWMCP_SETUP_PORT = '8684' }
  $port = [int]$env:RWMCP_SETUP_PORT
  if ($port -lt 1024 -or $port -gt 65535) { throw 'Control Center port must be between 1024 and 65535.' }
  return $port
}

function Control-Status {
  $state = Read-State
  $managed = Get-ManagedProcess $state
  if (-not $managed -and (Test-Path $StatePath)) {
    Remove-Item -Path $StatePath -Force -ErrorAction SilentlyContinue
  }
  $port = if ($state -and ($state.PSObject.Properties.Name -contains 'port')) { [int]$state.port } else { Apply-ControlEnvironment }
  $listenerOwner = Get-LoopbackListenerOwner $port
  $managedPortOwned = $null -ne $managed -and $null -ne $listenerOwner -and (Test-ProcessDescendant ([int]$listenerOwner) ([int]$managed.Id))
  $healthy = $false
  if ($managedPortOwned) {
    try {
      $response = Invoke-WebRequest -Uri "http://127.0.0.1:$port/" -UseBasicParsing -TimeoutSec 2
      $healthy = $response.StatusCode -eq 200
    } catch {}
  }
  return [pscustomobject]@{
    running = $null -ne $managed
    healthy = $healthy
    managedPortOwned = $managedPortOwned
    portOwnerPid = $listenerOwner
    pid = if ($managed) { [int]$managed.Id } else { $null }
    root = if ($state) { [string]$state.root } else { $Root }
    port = $port
    url = "http://127.0.0.1:$port/"
    stdoutLog = $StdoutLog
    stderrLog = $StderrLog
  }
}

function Start-ControlCenter {
  $port = Apply-ControlEnvironment
  $existingState = Read-State
  $existing = Get-ManagedProcess $existingState
  if (-not $existing) {
    $foreignOwner = Get-LoopbackListenerOwner $port
    if ($null -ne $foreignOwner) {
      throw "Control Center port $port is already in use by process $foreignOwner and is not owned by the managed Control Center."
    }
  }
  if ($existing) {
    $sameRoot = [string]::Equals([IO.Path]::GetFullPath([string]$existingState.root), [IO.Path]::GetFullPath($Root), [StringComparison]::OrdinalIgnoreCase)
    $samePort = [int]$existingState.port -eq $port
    if ($sameRoot -and $samePort) { return Control-Status }
    Stop-ProcessTree ([int]$existing.Id)
    Remove-Item -Path $StatePath -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 250
  }

  $hostScript = Join-Path $Root 'scripts\control-center-host-windows.ps1'
  if (-not (Test-Path $hostScript)) { throw "Control Center host script not found: $hostScript" }
  Remove-Item -Path $StdoutLog, $StderrLog -Force -ErrorAction SilentlyContinue

  # Match the MCP runtime supervisor pattern: the control command itself must not
  # own redirected child handles, otherwise captured callers can wait until the
  # long-lived Node process exits. A detached PowerShell host owns redirection.
  $powershell = Get-Command powershell.exe -ErrorAction Stop
  $argumentLine = @(
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', "`"$hostScript`"",
    '-Root', "`"$Root`"",
    '-Port', [string]$port,
    '-StdoutLog', "`"$StdoutLog`"",
    '-StderrLog', "`"$StderrLog`""
  ) -join ' '
  $process = Start-Process -FilePath $powershell.Source -ArgumentList $argumentLine -WorkingDirectory $Root -WindowStyle Hidden -PassThru
  $startedAt = [DateTimeOffset]$process.StartTime.ToUniversalTime()
  [ordered]@{
    version = 1
    pid = $process.Id
    root = $Root
    processPath = $powershell.Source
    port = $port
    startedAt = $startedAt.ToString('o')
  } | ConvertTo-Json | Set-Content -Path $StatePath -Encoding utf8

  $ready = $false
  foreach ($attempt in 1..60) {
    Start-Sleep -Milliseconds 250
    if ($process.HasExited) { break }
    $listenerOwner = Get-LoopbackListenerOwner $port
    if ($null -eq $listenerOwner -or -not (Test-ProcessDescendant ([int]$listenerOwner) ([int]$process.Id))) { continue }
    try {
      $response = Invoke-WebRequest -Uri "http://127.0.0.1:$port/" -UseBasicParsing -TimeoutSec 1
      if ($response.StatusCode -eq 200) { $ready = $true; break }
    } catch {}
  }
  if (-not $ready) {
    Stop-ProcessTree $process.Id
    Remove-Item -Path $StatePath -Force -ErrorAction SilentlyContinue
    $tail = if (Test-Path $StderrLog) { (Get-Content $StderrLog -Tail 40 | Out-String).Trim() } else { '' }
    throw "Control Center did not become healthy.$([Environment]::NewLine)$tail"
  }
  return Control-Status
}

function Stop-ControlCenter {
  $state = Read-State
  $managed = Get-ManagedProcess $state
  if ($managed) { Stop-ProcessTree ([int]$managed.Id) }
  Remove-Item -Path $StatePath -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 250
  return Control-Status
}

function Open-ControlCenter {
  $status = Start-ControlCenter
  $url = [string]$status.url
  Start-Process rundll32.exe -ArgumentList 'url.dll,FileProtocolHandler', $url | Out-Null
  return $status
}

$result = switch ($Action) {
  'Start' { Start-ControlCenter }
  'Stop' { Stop-ControlCenter }
  'Restart' { Stop-ControlCenter | Out-Null; Start-ControlCenter }
  'Status' { Control-Status }
  'Open' { Open-ControlCenter }
}

if ($Json) { $result | ConvertTo-Json -Depth 5 -Compress }
else { $result | Format-List }
