$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$worker = Join-Path $repoRoot 'scripts\autonomous-recovery-windows.ps1'
$tempLocal = Join-Path ([IO.Path]::GetTempPath()) ("rwmcp-convergence-" + [Guid]::NewGuid().ToString('N'))
$base = Join-Path $tempLocal 'RemoteWorkstationMCP'
$runtime = Join-Path $base 'runtime'
$bin = Join-Path $base 'bin'
$fakeRoot = Join-Path $base 'versions\vtest'
$fakeScripts = Join-Path $fakeRoot 'scripts'
$fakeRuntime = Join-Path $fakeScripts 'runtime-host-windows.ps1'
$marker = Join-Path $runtime 'launcher-action.txt'
$savedLocal = $env:LOCALAPPDATA
$p1 = $null
$p2 = $null
$env:LOCALAPPDATA = $tempLocal
try {
  New-Item -ItemType Directory -Force -Path $runtime, $bin, $fakeScripts | Out-Null
  . (Join-Path $repoRoot 'scripts\windows-settings.ps1')
  . (Join-Path $repoRoot 'scripts\windows-recovery-state.ps1')
  . (Join-Path $repoRoot 'scripts\windows-lifecycle-state.ps1')

  [IO.File]::WriteAllText($fakeRuntime, "Start-Sleep -Seconds 120`n", (New-Object Text.UTF8Encoding($false)))
  $fakeLauncher = @'
param([string]$Action)
$base = Split-Path -Parent $PSScriptRoot
$runtime = Join-Path $base 'runtime'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
[IO.File]::WriteAllText((Join-Path $runtime 'launcher-action.txt'), $Action, (New-Object Text.UTF8Encoding($false)))
exit 0
'@
  [IO.File]::WriteAllText((Join-Path $bin 'rwmcp.ps1'), $fakeLauncher, (New-Object Text.UTF8Encoding($false)))

  Set-RwmcpDesiredState -DesiredRunning $true -Mode OpenAI -Reason 'convergence-test' | Out-Null
  Clear-RwmcpRecoveryMaintenance -Reason 'convergence-test-ready' | Out-Null

  $powershell = (Get-Command powershell.exe -ErrorAction Stop).Source
  $argLine = @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$fakeRuntime`"") -join ' '
  $p1 = Start-Process -FilePath $powershell -ArgumentList $argLine -WindowStyle Hidden -PassThru
  $p2 = Start-Process -FilePath $powershell -ArgumentList $argLine -WindowStyle Hidden -PassThru
  Start-Sleep -Milliseconds 300

  $state = [ordered]@{
    version=1; pid=$p1.Id; mode='OpenAI'; root=$fakeRoot; entrypoint=$fakeRuntime;
    processPath=$powershell; port=58683; startedAt=([DateTimeOffset]$p1.StartTime.ToUniversalTime()).ToString('o')
  }
  [IO.File]::WriteAllText((Join-Path $runtime 'supervisor.json'), ($state | ConvertTo-Json) + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))

  & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $worker -Root $repoRoot -OneShot | Out-Null
  Start-Sleep -Milliseconds 500
  $p1.Refresh(); $p2.Refresh()
  if ($p1.HasExited) { throw 'Convergence killed the recorded active runtime host.' }
  if (-not $p2.HasExited) { throw "Convergence failed to kill duplicate managed runtime host PID $($p2.Id)." }

  Stop-Process -Id $p1.Id -Force -ErrorAction Stop
  $p1.WaitForExit()
  Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
  & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $worker -Root $repoRoot -OneShot | Out-Null
  if (-not (Test-Path -LiteralPath $marker)) { throw 'Stale supervisor state did not request autonomous recovery.' }
  if ((Get-Content -LiteralPath $marker -Raw).Trim() -ne 'StartOpenAI') { throw 'Stale supervisor recovery did not request StartOpenAI.' }

  Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
  $tx = Begin-RwmcpLifecycleTransaction -Kind update -LeaseSeconds 60 -Message 'convergence suppression test'
  try {
    & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $worker -Root $repoRoot -OneShot | Out-Null
    if (Test-Path -LiteralPath $marker) { throw 'Recovery raced an active lifecycle transaction.' }
  } finally {
    Complete-RwmcpLifecycleTransaction -Epoch ([int64]$tx.epoch) -Outcome SUCCEEDED | Out-Null
  }

  Write-Host 'Recovery convergence/interlock test passed.' -ForegroundColor Green
} finally {
  foreach ($process in @($p1,$p2)) {
    if ($process) {
      try { $process.Refresh(); if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue } } catch {}
      try { $process.Dispose() } catch {}
    }
  }
  $env:LOCALAPPDATA = $savedLocal
  Remove-Item -LiteralPath $tempLocal -Recurse -Force -ErrorAction SilentlyContinue
}
