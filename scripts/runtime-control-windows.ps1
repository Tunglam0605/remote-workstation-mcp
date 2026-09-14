param(
  [ValidateSet('Start','Stop','Restart','Status','RegisterStartup','UnregisterStartup')]
  [string]$Action = 'Status',
  [ValidateSet('Local','OpenAI')]
  [string]$Mode = 'OpenAI',
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
$StatePath = Join-Path $StateDir 'supervisor.json'
$StdoutLog = Join-Path $StateDir 'supervisor.stdout.log'
$StderrLog = Join-Path $StateDir 'supervisor.stderr.log'
$StdinNull = Join-Path $StateDir 'empty.stdin'
$TaskName = 'Remote Workstation MCP'
New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
if (-not (Test-Path $StdinNull)) { Set-Content -Path $StdinNull -Value '' -Encoding ascii }

function Read-State {
  if (-not (Test-Path $StatePath)) { return $null }
  try { return Get-Content -Path $StatePath -Raw | ConvertFrom-Json }
  catch { return $null }
}

function Get-ManagedProcess($state) {
  if (-not $state -or -not ($state.PSObject.Properties.Name -contains 'pid')) { return $null }
  $processId = [int]$state.pid
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction SilentlyContinue
  if (-not $process) { return $null }
  $expected = if ($state.PSObject.Properties.Name -contains 'entrypoint') { [string]$state.entrypoint } else { '' }
  if ($expected -and ($process.CommandLine -notlike "*$expected*")) { return $null }
  return $process
}

function Stop-ProcessTree([int]$rootProcessId) {
  $all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId)
  $queue = New-Object System.Collections.Queue
  $descendants = New-Object System.Collections.ArrayList
  $queue.Enqueue($rootProcessId)
  while ($queue.Count -gt 0) {
    $parent = [int]$queue.Dequeue()
    foreach ($child in @($all | Where-Object { [int]$_.ParentProcessId -eq $parent })) {
      $childId = [int]$child.ProcessId
      [void]$descendants.Add($childId)
      $queue.Enqueue($childId)
    }
  }
  for ($i = $descendants.Count - 1; $i -ge 0; $i--) {
    Stop-Process -Id ([int]$descendants[$i]) -Force -ErrorAction SilentlyContinue
  }
  Stop-Process -Id $rootProcessId -Force -ErrorAction SilentlyContinue
}

function Test-StartupTaskRegistered {
  $schtasks = Get-Command schtasks.exe -ErrorAction SilentlyContinue
  if (-not $schtasks) { return $false }

  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $schtasks.Source
  $psi.Arguments = "/Query /TN `"$TaskName`""
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $probe = New-Object System.Diagnostics.Process
  $probe.StartInfo = $psi
  try {
    [void]$probe.Start()
    if (-not $probe.WaitForExit(2000)) {
      try { $probe.Kill() } catch {}
      return $false
    }
    return $probe.ExitCode -eq 0
  } catch {
    return $false
  } finally {
    $probe.Dispose()
  }
}

function Apply-RuntimeEnvironment([string]$runtimeMode) {
  $includeSecret = $runtimeMode -eq 'OpenAI'
  Apply-RwmcpPersistedEnvironment -Root $Root -IncludeOpenAISecret:$includeSecret | Out-Null

  $externalConfigDir = Join-Path $UserConfigDir 'config'
  $externalPolicy = Join-Path $externalConfigDir 'policy.yaml'
  $externalHosts = Join-Path $externalConfigDir 'hosts.yaml'
  $repoPolicy = Join-Path $Root 'config\policy.yaml'
  $repoHosts = Join-Path $Root 'config\hosts.yaml'

  if (-not $env:RWMCP_POLICY) { $env:RWMCP_POLICY = if (Test-Path $externalPolicy) { $externalPolicy } else { $repoPolicy } }
  if (-not $env:RWMCP_HOSTS) { $env:RWMCP_HOSTS = if (Test-Path $externalHosts) { $externalHosts } else { $repoHosts } }
  if (-not $env:RWMCP_AUDIT) { $env:RWMCP_AUDIT = Join-Path $UserConfigDir 'audit.jsonl' }
  if (-not $env:RWMCP_CLIENT_ID) { $env:RWMCP_CLIENT_ID = if ($runtimeMode -eq 'OpenAI') { 'openai-tunnel' } else { 'windows-local' } }
  if (-not $env:RWMCP_CLIENT_TYPE) { $env:RWMCP_CLIENT_TYPE = if ($runtimeMode -eq 'OpenAI') { 'chatgpt' } else { 'mcp' } }
  if (-not $env:RWMCP_PORT) { $env:RWMCP_PORT = '8765' }

  if (-not (Test-Path $env:RWMCP_POLICY)) { throw "Policy file not found: $($env:RWMCP_POLICY)" }
  if (-not (Test-Path $env:RWMCP_HOSTS)) { throw "SSH hosts config not found: $($env:RWMCP_HOSTS)" }

  if ($runtimeMode -eq 'OpenAI') {
    if (-not $env:CONTROL_PLANE_TUNNEL_ID) { throw 'Tunnel ID is not configured. Open the Setup & Control Center first.' }
    if (-not $env:CONTROL_PLANE_API_KEY) { throw 'OpenAI runtime API key is not available. Save it with DPAPI or set CONTROL_PLANE_API_KEY.' }
    if (-not $env:CLOUDFLARED_MANAGED) { $env:CLOUDFLARED_MANAGED = 'false' }
    $tunnelBinary = if ($env:RWMCP_OPENAI_TUNNEL_CLIENT) {
      $env:RWMCP_OPENAI_TUNNEL_CLIENT
    } else {
      Join-Path $Root 'runtime\openai-tunnel\tunnel-client.exe'
    }
    if (-not (Test-Path $tunnelBinary)) { throw "OpenAI tunnel-client is not installed: $tunnelBinary" }
    $env:RWMCP_OPENAI_TUNNEL_CLIENT = $tunnelBinary
  }
}

function Runtime-Status {
  $state = Read-State
  $managed = Get-ManagedProcess $state
  if (-not $managed -and (Test-Path $StatePath)) {
    Remove-Item -Path $StatePath -Force -ErrorAction SilentlyContinue
  }

  $port = if ($state -and ($state.PSObject.Properties.Name -contains 'port')) { [int]$state.port } elseif ($env:RWMCP_PORT) { [int]$env:RWMCP_PORT } else { 8765 }
  $mcpHealthy = $false
  $mcpVersion = $null
  $httpAuth = $null
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/healthz" -TimeoutSec 2
    $mcpHealthy = $health.ok -eq $true
    $mcpVersion = $health.version
    $httpAuth = $health.httpAuth
  } catch {}

  $tunnelReady = $false
  $healthUrlPath = Join-Path $Root 'runtime\openai-tunnel\health-url'
  if (Test-Path $healthUrlPath) {
    try {
      $base = (Get-Content -Path $healthUrlPath -Raw).Trim()
      if ($base) {
        $ready = Invoke-WebRequest -Uri "$base/readyz" -UseBasicParsing -TimeoutSec 2
        $tunnelReady = $ready.StatusCode -eq 200
      }
    } catch {}
  }

  $startupRegistered = Test-StartupTaskRegistered

  return [pscustomobject]@{
    running = $null -ne $managed
    pid = if ($managed) { [int]$managed.ProcessId } else { $null }
    mode = if ($state -and ($state.PSObject.Properties.Name -contains 'mode')) { [string]$state.mode } else { $null }
    root = if ($state -and ($state.PSObject.Properties.Name -contains 'root')) { [string]$state.root } else { $Root }
    port = $port
    mcpHealthy = $mcpHealthy
    mcpVersion = $mcpVersion
    httpAuth = $httpAuth
    tunnelReady = $tunnelReady
    startupRegistered = $startupRegistered
    stdoutLog = $StdoutLog
    stderrLog = $StderrLog
  }
}

function Start-Runtime([string]$runtimeMode) {
  $existing = Runtime-Status
  if ($existing.running) { return $existing }

  Apply-RuntimeEnvironment $runtimeMode
  $node = Get-Command node -ErrorAction Stop
  $entrypoint = if ($runtimeMode -eq 'OpenAI') {
    Join-Path $Root 'dist\openai-tunnel-cli.js'
  } else {
    Join-Path $Root 'dist\cli.js'
  }
  if (-not (Test-Path $entrypoint)) { throw "Runtime entrypoint not found: $entrypoint" }

  Remove-Item -Path $StdoutLog, $StderrLog -Force -ErrorAction SilentlyContinue
  Set-Content -Path $StdinNull -Value '' -Encoding ascii
  $arguments = @($entrypoint)
  if ($runtimeMode -eq 'Local') { $arguments += '--http' }
  $process = Start-Process -FilePath $node.Source -ArgumentList $arguments -WorkingDirectory $Root -WindowStyle Hidden -RedirectStandardInput $StdinNull -RedirectStandardOutput $StdoutLog -RedirectStandardError $StderrLog -PassThru
  $state = [ordered]@{
    version = 1
    pid = $process.Id
    mode = $runtimeMode
    root = $Root
    entrypoint = $entrypoint
    port = [int]$env:RWMCP_PORT
    startedAt = [DateTimeOffset]::UtcNow.ToString('o')
  }
  $state | ConvertTo-Json | Set-Content -Path $StatePath -Encoding utf8

  $ready = $false
  foreach ($attempt in 1..60) {
    Start-Sleep -Milliseconds 250
    if ($process.HasExited) { break }
    try {
      $health = Invoke-RestMethod -Uri "http://127.0.0.1:$($env:RWMCP_PORT)/healthz" -TimeoutSec 1
      if ($health.ok -eq $true) { $ready = $true; break }
    } catch {}
  }
  if (-not $ready) {
    Stop-ProcessTree $process.Id
    Remove-Item -Path $StatePath -Force -ErrorAction SilentlyContinue
    $tail = if (Test-Path $StderrLog) { (Get-Content $StderrLog -Tail 40 | Out-String).Trim() } else { '' }
    throw "Runtime did not become healthy.$([Environment]::NewLine)$tail"
  }
  return Runtime-Status
}

function Stop-Runtime {
  $state = Read-State
  $managed = Get-ManagedProcess $state
  if ($managed) { Stop-ProcessTree ([int]$managed.ProcessId) }
  Remove-Item -Path $StatePath -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 300
  return Runtime-Status
}

function Register-Startup([string]$runtimeMode) {
  $stableLauncher = Join-Path $UserConfigDir 'bin\rwmcp.ps1'
  if (Test-Path $stableLauncher) {
    $stableAction = if ($runtimeMode -eq 'OpenAI') { 'StartOpenAI' } else { 'Start' }
    $argument = "-NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$stableLauncher`" -Action $stableAction"
  } else {
    $script = Join-Path $Root 'scripts\runtime-control-windows.ps1'
    $argument = "-NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`" -Action Start -Mode $runtimeMode -Root `"$Root`""
  }
  $actionObject = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argument
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Days 3650) -MultipleInstances IgnoreNew
  $principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $TaskName -Action $actionObject -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
  return Runtime-Status
}

function Unregister-Startup {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  return Runtime-Status
}

$result = switch ($Action) {
  'Start' { Start-Runtime $Mode }
  'Stop' { Stop-Runtime }
  'Restart' { Stop-Runtime | Out-Null; Start-Runtime $Mode }
  'Status' { Runtime-Status }
  'RegisterStartup' { Register-Startup $Mode }
  'UnregisterStartup' { Unregister-Startup }
}

if ($Json) { $result | ConvertTo-Json -Depth 5 -Compress }
else { $result | Format-List }
