$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$hostScript = Join-Path $repoRoot 'scripts\control-center-host-windows.ps1'
if (-not (Test-Path -LiteralPath $hostScript)) { throw "Control Center host script is missing: $hostScript" }

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("rwmcp-control-watchdog-" + [Guid]::NewGuid().ToString('N'))
$dist = Join-Path $tempRoot 'dist'
$scriptsDir = Join-Path $tempRoot 'scripts'
$stdoutLog = Join-Path $tempRoot 'stdout.log'
$stderrLog = Join-Path $tempRoot 'stderr.log'
New-Item -ItemType Directory -Force -Path $dist, $scriptsDir | Out-Null

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
$listener.Stop()

$fakeWeb = @'
import http from 'node:http';
const args = process.argv.slice(2);
const idx = args.indexOf('--port');
if (idx < 0 || !args[idx + 1]) process.exit(2);
const port = Number(args[idx + 1]);
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('ok');
});
server.listen(port, '127.0.0.1');
'@
[IO.File]::WriteAllText((Join-Path $dist 'setup-web-cli.js'), $fakeWeb, (New-Object Text.UTF8Encoding($false)))

$fakeRecovery = @'
param([string]$Root,[string]$LogPath)
$stateDir = Split-Path -Parent $LogPath
$statePath = Join-Path $stateDir 'recovery-supervisor-state.json'
$payload = [ordered]@{
  version = 1
  pid = $PID
  root = $Root
  evaluation = 'test-heartbeat-once'
  updatedAt = [DateTimeOffset]::UtcNow.ToString('o')
}
[IO.File]::WriteAllText($statePath, ($payload | ConvertTo-Json) + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
Start-Sleep -Seconds 120
'@
[IO.File]::WriteAllText((Join-Path $scriptsDir 'autonomous-recovery-windows.ps1'), $fakeRecovery, (New-Object Text.UTF8Encoding($false)))

function Get-ListenerPid([int]$TargetPort) {
  $connection = Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $TargetPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($connection) { return [int]$connection.OwningProcess }
  return $null
}

function Wait-Listener([int]$TargetPort, [int]$NotPid = 0, [int]$TimeoutSeconds = 15) {
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
  while ([DateTimeOffset]::UtcNow -lt $deadline) {
    $pidValue = Get-ListenerPid $TargetPort
    if ($pidValue -and ($NotPid -eq 0 -or $pidValue -ne $NotPid)) { return $pidValue }
    Start-Sleep -Milliseconds 250
  }
  return $null
}


function Wait-RecoveryReplacement([string]$HostLogPath, [int]$TimeoutSeconds = 15) {
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
  while ([DateTimeOffset]::UtcNow -lt $deadline) {
    if (Test-Path -LiteralPath $HostLogPath) {
      $matches = Select-String -Path $HostLogPath -Pattern 'Autonomous recovery child started pid=(\d+)\.' -AllMatches
      $pids = @()
      foreach ($matchLine in $matches) {
        foreach ($m in $matchLine.Matches) { $pids += [int]$m.Groups[1].Value }
      }
      $unique = @($pids | Select-Object -Unique)
      if ($unique.Count -ge 2) { return $unique }
    }
    Start-Sleep -Milliseconds 250
  }
  return @()
}

$hostProcess = $null
$childPid = $null
$replacementPid = $null
try {
  $powershell = (Get-Command powershell.exe -ErrorAction Stop).Source
  $argumentLine = @(
    '-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$hostScript`"",
    '-Root',"`"$tempRoot`"",'-Port',[string]$port,
    '-StdoutLog',"`"$stdoutLog`"",'-StderrLog',"`"$stderrLog`"",
    '-RecoveryHeartbeatStartupGraceSeconds','1','-RecoveryHeartbeatStaleSeconds','2'
  ) -join ' '
  $hostProcess = Start-Process -FilePath $powershell -ArgumentList $argumentLine -WindowStyle Hidden -PassThru

  $childPid = Wait-Listener $port 0 15
  if (-not $childPid) { throw 'Initial Control Center child did not become healthy.' }
  $response = Invoke-WebRequest -Uri "http://127.0.0.1:$port/" -UseBasicParsing -TimeoutSec 2
  if ($response.StatusCode -ne 200) { throw "Unexpected initial HTTP status $($response.StatusCode)." }

  Stop-Process -Id $childPid -Force -ErrorAction Stop
  $replacementPid = Wait-Listener $port $childPid 15
  if (-not $replacementPid) {
    $log = if (Test-Path $stderrLog) { Get-Content $stderrLog -Raw } else { '<no stderr log>' }
    throw "Control Center watchdog did not replace killed child PID $childPid.`n$log"
  }
  $response = Invoke-WebRequest -Uri "http://127.0.0.1:$port/" -UseBasicParsing -TimeoutSec 2
  if ($response.StatusCode -ne 200) { throw "Unexpected recovered HTTP status $($response.StatusCode)." }
  Write-Host "Control Center watchdog recovered child $childPid -> $replacementPid on port $port." -ForegroundColor Green


  $hostLog = Join-Path $tempRoot 'control-center-host.log'
  $recoveryPids = Wait-RecoveryReplacement $hostLog 15
  if ($recoveryPids.Count -lt 2) {
    $log = if (Test-Path -LiteralPath $hostLog) { Get-Content -LiteralPath $hostLog -Raw } else { '<no host log>' }
    throw "Recovery heartbeat watchdog did not replace the hung recovery child.`n$log"
  }
  Write-Host "Recovery heartbeat watchdog replaced hung worker $($recoveryPids[0]) -> $($recoveryPids[1])." -ForegroundColor Green
} finally {
  foreach ($pidValue in @($replacementPid, $childPid)) {
    if ($pidValue) { Stop-Process -Id $pidValue -Force -ErrorAction SilentlyContinue }
  }
  if ($hostProcess -and -not $hostProcess.HasExited) { Stop-Process -Id $hostProcess.Id -Force -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
