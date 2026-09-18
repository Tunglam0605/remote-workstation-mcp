$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("rwmcp-control-rehome-" + [Guid]::NewGuid().ToString('N'))
$slotA = Join-Path $tempRoot 'versions\v-test-a'
$slotB = Join-Path $tempRoot 'versions\v-test-b'
$localAppData = Join-Path $tempRoot 'localappdata'
$originalLocalAppData = $env:LOCALAPPDATA
$originalSetupPort = $env:RWMCP_SETUP_PORT

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

$fakeRecovery = @'
param([string]$Root,[string]$LogPath)
$stateDir = Split-Path -Parent $LogPath
$statePath = Join-Path $stateDir 'recovery-supervisor-state.json'
while ($true) {
  $payload = [ordered]@{
    version = 1
    pid = $PID
    root = $Root
    evaluation = 'slot-rehome-test'
    updatedAt = [DateTimeOffset]::UtcNow.ToString('o')
  }
  [IO.File]::WriteAllText($statePath, ($payload | ConvertTo-Json) + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
  Start-Sleep -Milliseconds 500
}
'@

function Initialize-FakeSlot([string]$Root) {
  $dist = Join-Path $Root 'dist'
  $scripts = Join-Path $Root 'scripts'
  New-Item -ItemType Directory -Force -Path $dist, $scripts | Out-Null
  [IO.File]::WriteAllText((Join-Path $dist 'setup-web-cli.js'), $fakeWeb, (New-Object Text.UTF8Encoding($false)))
  [IO.File]::WriteAllText((Join-Path $scripts 'autonomous-recovery-windows.ps1'), $fakeRecovery, (New-Object Text.UTF8Encoding($false)))
  foreach ($name in @('control-center-windows.ps1','control-center-host-windows.ps1','windows-settings.ps1')) {
    Copy-Item -LiteralPath (Join-Path $repoRoot "scripts\$name") -Destination (Join-Path $scripts $name) -Force
  }
}

function Invoke-Control([string]$Root, [string]$Action) {
  $script = Join-Path $Root 'scripts\control-center-windows.ps1'
  $raw = & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $script -Action $Action -Root $Root -Json
  if ($LASTEXITCODE -ne 0) { throw "Control Center $Action failed for $Root with exit code $LASTEXITCODE." }
  $json = @($raw | Where-Object { $_ -is [string] -and $_.TrimStart().StartsWith('{') } | Select-Object -Last 1)
  if ($json.Count -ne 1) { throw "Control Center $Action did not return one JSON status payload." }
  return ([string]$json[0] | ConvertFrom-Json)
}

function Wait-RecoveryRoot([string]$ExpectedRoot, [int]$TimeoutSeconds = 15) {
  $statePath = Join-Path $localAppData 'RemoteWorkstationMCP\runtime\recovery-supervisor-state.json'
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
  while ([DateTimeOffset]::UtcNow -lt $deadline) {
    if (Test-Path -LiteralPath $statePath) {
      try {
        $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
        if ([string]::Equals([IO.Path]::GetFullPath([string]$state.root), [IO.Path]::GetFullPath($ExpectedRoot), [StringComparison]::OrdinalIgnoreCase)) {
          return $state
        }
      } catch {}
    }
    Start-Sleep -Milliseconds 250
  }
  throw "Recovery worker did not converge to root $ExpectedRoot."
}

$hostPidA = $null
$hostPidB = $null
try {
  Initialize-FakeSlot $slotA
  Initialize-FakeSlot $slotB
  $env:LOCALAPPDATA = $localAppData
  $env:RWMCP_SETUP_PORT = [string]$port

  $statusA = Invoke-Control $slotA 'Start'
  if (-not $statusA.healthy -or -not $statusA.managedPortOwned) { throw 'Slot A Control Center was not healthy.' }
  if (-not [string]::Equals([IO.Path]::GetFullPath([string]$statusA.root), [IO.Path]::GetFullPath($slotA), [StringComparison]::OrdinalIgnoreCase)) {
    throw "Slot A status reported unexpected root $($statusA.root)."
  }
  $hostPidA = [int]$statusA.pid
  [void](Wait-RecoveryRoot $slotA)

  $statusB = Invoke-Control $slotB 'Start'
  if (-not $statusB.healthy -or -not $statusB.managedPortOwned) { throw 'Slot B Control Center was not healthy after re-home.' }
  if (-not [string]::Equals([IO.Path]::GetFullPath([string]$statusB.root), [IO.Path]::GetFullPath($slotB), [StringComparison]::OrdinalIgnoreCase)) {
    throw "Slot B status reported unexpected root $($statusB.root)."
  }
  $hostPidB = [int]$statusB.pid
  if ($hostPidB -eq $hostPidA) { throw 'Control Center host PID did not change during slot re-home.' }

  Start-Sleep -Milliseconds 500
  if (Get-Process -Id $hostPidA -ErrorAction SilentlyContinue) { throw "Old slot Control Center host PID $hostPidA is still running." }

  $response = Invoke-WebRequest -Uri "http://127.0.0.1:$port/" -UseBasicParsing -TimeoutSec 2
  if ($response.StatusCode -ne 200) { throw "Re-homed Control Center returned HTTP $($response.StatusCode)." }
  $recovery = Wait-RecoveryRoot $slotB

  Write-Host "Control Center re-home passed: host $hostPidA -> $hostPidB, recovery PID $($recovery.pid), port $port." -ForegroundColor Green
} finally {
  try {
    if (Test-Path -LiteralPath (Join-Path $slotB 'scripts\control-center-windows.ps1')) {
      Invoke-Control $slotB 'Stop' | Out-Null
    } elseif (Test-Path -LiteralPath (Join-Path $slotA 'scripts\control-center-windows.ps1')) {
      Invoke-Control $slotA 'Stop' | Out-Null
    }
  } catch {}
  foreach ($pidValue in @($hostPidB, $hostPidA)) {
    if ($pidValue) { Stop-Process -Id $pidValue -Force -ErrorAction SilentlyContinue }
  }
  if ($null -eq $originalLocalAppData) { Remove-Item Env:LOCALAPPDATA -ErrorAction SilentlyContinue } else { $env:LOCALAPPDATA = $originalLocalAppData }
  if ($null -eq $originalSetupPort) { Remove-Item Env:RWMCP_SETUP_PORT -ErrorAction SilentlyContinue } else { $env:RWMCP_SETUP_PORT = $originalSetupPort }
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
