param(
  [Parameter(Mandatory = $true)]
  [string]$Root,
  [ValidateSet('Local','OpenAI')]
  [string]$Mode = 'OpenAI'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Root = (Resolve-Path $Root).Path
$runtimeScript = Join-Path $Root 'scripts\runtime-control-windows.ps1'
if (-not (Test-Path $runtimeScript)) { throw "Runtime control script not found: $runtimeScript" }

function Get-UserBase {
  $localBase = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $HOME 'AppData\Local' }
  return Join-Path $localBase 'RemoteWorkstationMCP'
}

function Get-ControlPort {
  $settingsPath = Join-Path (Get-UserBase) 'settings.json'
  if (Test-Path $settingsPath) {
    try {
      $settings = Get-Content -Path $settingsPath -Raw | ConvertFrom-Json
      if ($settings.PSObject.Properties.Name -contains 'controlPort') {
        $candidate = [int]$settings.controlPort
        if ($candidate -ge 1024 -and $candidate -le 65535) { return $candidate }
      }
    } catch {}
  }
  return 8684
}

function Get-ManagedRuntimePid {
  $statePath = Join-Path (Get-UserBase) 'runtime\runtime.json'
  if (-not (Test-Path $statePath)) { return $null }
  try {
    $state = Get-Content -Path $statePath -Raw | ConvertFrom-Json
    return [int]$state.pid
  } catch { return $null }
}

function Test-DescendantOf([int]$ProcessId, [int]$AncestorId) {
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

function Invoke-ControlCenterRestart {
  $port = Get-ControlPort
  $base = "http://127.0.0.1:$port"
  $page = Invoke-WebRequest -Uri "$base/" -UseBasicParsing -TimeoutSec 3
  if ($page.StatusCode -ne 200) { throw "Control Center returned HTTP $($page.StatusCode)." }
  $match = [regex]::Match([string]$page.Content, 'const token = ("[^"\r\n]+");')
  if (-not $match.Success) { throw 'Control Center CSRF token was not found.' }
  $token = $match.Groups[1].Value | ConvertFrom-Json
  $headers = @{ 'x-rwmcp-setup-token' = $token; 'Origin' = $base }
  $body = @{ action = 'Restart'; mode = $Mode } | ConvertTo-Json -Compress
  $response = Invoke-RestMethod -Uri "$base/api/runtime/action" -Method Post -Headers $headers -ContentType 'application/json' -Body $body -TimeoutSec 10
  if (-not $response.accepted) { throw 'Control Center did not accept the restart handoff.' }
  return $response
}

try {
  $handoff = Invoke-ControlCenterRestart
  [pscustomobject]@{
    accepted = $true
    via = 'control-center'
    mode = $Mode
    message = 'Restart accepted by the persistent Control Center. The MCP/tunnel may disconnect briefly and should reconnect automatically.'
  } | Format-List
  exit 0
} catch {
  $runtimePid = Get-ManagedRuntimePid
  $insideRuntime = $null -ne $runtimePid -and (Test-DescendantOf $PID $runtimePid)
  if ($insideRuntime) {
    throw "Safe restart handoff failed while this command is running inside the managed runtime tree. Refusing a direct self-killing restart. Control Center error: $($_.Exception.Message)"
  }
  Write-Warning "Control Center handoff unavailable; using direct restart from an external process: $($_.Exception.Message)"
  & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $runtimeScript -Action Restart -Mode $Mode -Root $Root
  if ($LASTEXITCODE -ne 0) { throw "Direct runtime restart failed with exit code $LASTEXITCODE." }
}
