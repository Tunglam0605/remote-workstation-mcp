$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$runtimeControl = Join-Path $repoRoot 'scripts\runtime-control-windows.ps1'
$controlCenter = Join-Path $repoRoot 'scripts\control-center-windows.ps1'
$tempLocal = Join-Path ([IO.Path]::GetTempPath()) ("rwmcp-runtime-start-lock-" + [Guid]::NewGuid().ToString('N'))
$workspace = Join-Path $tempLocal 'workspace'
$policy = Join-Path $tempLocal 'policy.yaml'
$hosts = Join-Path $tempLocal 'hosts.yaml'
$out1 = Join-Path $tempLocal 'start-1.out'
$err1 = Join-Path $tempLocal 'start-1.err'
$out2 = Join-Path $tempLocal 'start-2.out'
$err2 = Join-Path $tempLocal 'start-2.err'

function Get-FreePort {
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  $listener.Start()
  try { return ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port }
  finally { $listener.Stop() }
}

function Read-LastJson([string]$Path) {
  $lines = @(Get-Content -LiteralPath $Path -ErrorAction Stop | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  for ($i = $lines.Count - 1; $i -ge 0; $i--) {
    try { return ($lines[$i] | ConvertFrom-Json -ErrorAction Stop) } catch {}
  }
  throw "No JSON status found in $Path"
}

$saved = @{}
foreach ($name in @('LOCALAPPDATA','RWMCP_PORT','RWMCP_SETUP_PORT','RWMCP_POLICY','RWMCP_HOSTS','RWMCP_AUDIT')) {
  $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

$p1 = $null
$p2 = $null
try {
  New-Item -ItemType Directory -Force -Path $tempLocal, $workspace | Out-Null
  $workspaceYaml = $workspace.Replace('\', '/')
  @"
version: 1
mode: workspace
workspaces:
  - id: concurrency
    root: $workspaceYaml
    readOnly: false
filesystem:
  maxReadBytes: 1048576
  maxWriteBytes: 1048576
search:
  maxResults: 20
  maxFiles: 100
  maxFileBytes: 1048576
process:
  allowExecutables: [node]
  inheritEnv: [PATH, USERPROFILE, TEMP, TMP]
  maxOutputBytes: 65536
  maxRuntimeMs: 30000
tasks: {}
"@ | Set-Content -LiteralPath $policy -Encoding utf8
  "version: 1`nhosts: []`n" | Set-Content -LiteralPath $hosts -Encoding utf8

  $env:LOCALAPPDATA = $tempLocal
  $env:RWMCP_PORT = [string](Get-FreePort)
  $env:RWMCP_SETUP_PORT = [string](Get-FreePort)
  $env:RWMCP_POLICY = $policy
  $env:RWMCP_HOSTS = $hosts
  $env:RWMCP_AUDIT = Join-Path $tempLocal 'audit.jsonl'

  $powershell = (Get-Command powershell.exe -ErrorAction Stop).Source
  $args = @(
    '-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$runtimeControl`"",
    '-Action','Start','-Mode','Local','-Root',"`"$repoRoot`"",'-Json'
  ) -join ' '

  $p1 = Start-Process -FilePath $powershell -ArgumentList $args -WorkingDirectory $repoRoot -PassThru -WindowStyle Hidden -RedirectStandardOutput $out1 -RedirectStandardError $err1
  Start-Sleep -Milliseconds 25
  $p2 = Start-Process -FilePath $powershell -ArgumentList $args -WorkingDirectory $repoRoot -PassThru -WindowStyle Hidden -RedirectStandardOutput $out2 -RedirectStandardError $err2

  if (-not $p1.WaitForExit(60000)) { throw 'First concurrent Start timed out.' }
  if (-not $p2.WaitForExit(60000)) { throw 'Second concurrent Start timed out.' }
  if ($p1.ExitCode -ne 0) { throw "First concurrent Start failed code=$($p1.ExitCode): $(Get-Content $err1 -Raw -ErrorAction SilentlyContinue)" }
  if ($p2.ExitCode -ne 0) { throw "Second concurrent Start failed code=$($p2.ExitCode): $(Get-Content $err2 -Raw -ErrorAction SilentlyContinue)" }

  $first = Read-LastJson $out1
  $second = Read-LastJson $out2
  if (-not $first.running -or -not $second.running) { throw 'Concurrent Start did not return a running runtime to both callers.' }
  if ([int]$first.pid -le 0 -or [int]$first.pid -ne [int]$second.pid) {
    throw "Concurrent Start returned different supervisors: first=$($first.pid) second=$($second.pid)"
  }

  $rootNeedle = [IO.Path]::GetFullPath($repoRoot)
  $hostsFound = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction Stop | Where-Object {
    $line = [string]$_.CommandLine
    $line -and $line.IndexOf('runtime-host-windows.ps1', [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
      $line.IndexOf($rootNeedle, [StringComparison]::OrdinalIgnoreCase) -ge 0
  })
  if ($hostsFound.Count -ne 1) {
    throw "Expected exactly one runtime host after concurrent Start, found $($hostsFound.Count): $(@($hostsFound.ProcessId) -join ',')"
  }
  if ([int]$hostsFound[0].ProcessId -ne [int]$first.pid) {
    throw "Runtime state PID $($first.pid) does not match sole host PID $($hostsFound[0].ProcessId)."
  }

  $lockPath = Join-Path $tempLocal 'RemoteWorkstationMCP\runtime\runtime-start.lock'
  if (-not (Test-Path -LiteralPath $lockPath)) { throw "Runtime start lock file was not created: $lockPath" }

  Write-Host "Concurrent runtime Start serialized successfully on PID $($first.pid)." -ForegroundColor Green
} finally {
  try { & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $runtimeControl -Action Stop -Mode Local -Root $repoRoot -Json | Out-Null } catch {}
  try { & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $controlCenter -Action Stop -Root $repoRoot -Json | Out-Null } catch {}
  foreach ($process in @($p1, $p2)) {
    if ($process -and -not $process.HasExited) { try { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue } catch {} }
    if ($process) { try { $process.Dispose() } catch {} }
  }
  foreach ($name in $saved.Keys) {
    [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process')
  }
  Remove-Item -LiteralPath $tempLocal -Recurse -Force -ErrorAction SilentlyContinue
}
