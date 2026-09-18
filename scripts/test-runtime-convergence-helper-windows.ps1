$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$tempLocal = Join-Path ([IO.Path]::GetTempPath()) ("rwmcp-runtime-convergence-helper-" + [Guid]::NewGuid().ToString('N'))
$base = Join-Path $tempLocal 'RemoteWorkstationMCP'
$runtime = Join-Path $base 'runtime'
$oldRoot = Join-Path $base 'versions\vold'
$newRoot = Join-Path $base 'versions\vnew'
$oldScripts = Join-Path $oldRoot 'scripts'
$newScripts = Join-Path $newRoot 'scripts'
$oldDist = Join-Path $oldRoot 'dist'
$statePath = Join-Path $runtime 'supervisor.json'
$connectionPath = Join-Path $runtime 'connection-state.json'
$savedLocal = $env:LOCALAPPDATA
$host1 = $null
$host2 = $null
$orphanTunnel = $null
$orphanMcp = $null
$oldRecovery = $null
$newRecovery = $null
$duplicateNewRecovery = $null

try {
  New-Item -ItemType Directory -Force -Path $runtime, $oldScripts, $newScripts, $oldDist | Out-Null
  $env:LOCALAPPDATA = $tempLocal
  . (Join-Path $repoRoot 'scripts\windows-settings.ps1')
  . (Join-Path $repoRoot 'scripts\windows-runtime-convergence.ps1')

  $fakeHost = Join-Path $oldScripts 'runtime-host-windows.ps1'
  [IO.File]::WriteAllText($fakeHost, "Start-Sleep -Seconds 120" + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
  $fakeTunnel = Join-Path $oldDist 'openai-tunnel-cli.js'
  $fakeMcp = Join-Path $oldDist 'cli.js'
  [IO.File]::WriteAllText($fakeTunnel, "setInterval(() => {}, 1000);" + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
  [IO.File]::WriteAllText($fakeMcp, "setInterval(() => {}, 1000);" + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))

  $powershell = (Get-Command powershell.exe -ErrorAction Stop).Source
  $hostArgs = @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',$fakeHost)
  $host1 = Start-Process -FilePath $powershell -ArgumentList $hostArgs -WindowStyle Hidden -PassThru
  $host2 = Start-Process -FilePath $powershell -ArgumentList $hostArgs -WindowStyle Hidden -PassThru
  Start-Sleep -Milliseconds 300

  $state = [ordered]@{
    version=1; pid=$host1.Id; mode='OpenAI'; root=$oldRoot; entrypoint=$fakeHost;
    processPath=$powershell; port=58683; startedAt=([DateTimeOffset]$host1.StartTime.ToUniversalTime()).ToString('o')
  }
  [IO.File]::WriteAllText($statePath, ($state | ConvertTo-Json) + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))

  $kept = Invoke-RwmcpRuntimeConvergence -SupervisorStatePath $statePath -ConnectionStatePath $connectionPath -TargetRoot $oldRoot
  Start-Sleep -Milliseconds 300
  $host1.Refresh(); $host2.Refresh()
  if (-not $kept -or [int]$kept.Id -ne [int]$host1.Id) { throw 'Same-slot convergence did not preserve the recorded runtime host.' }
  if ($host1.HasExited) { throw 'Same-slot convergence killed the recorded runtime host.' }
  if (-not $host2.HasExited) { throw 'Same-slot convergence failed to remove a duplicate runtime host.' }

  $switched = Invoke-RwmcpRuntimeConvergence -SupervisorStatePath $statePath -ConnectionStatePath $connectionPath -TargetRoot $newRoot
  Start-Sleep -Milliseconds 300
  $host1.Refresh()
  if ($switched) { throw 'Cross-slot convergence returned an old-slot runtime as active.' }
  if (-not $host1.HasExited) { throw 'Cross-slot convergence failed to stop the old-slot runtime host.' }

  $node = (Get-Command node.exe -ErrorAction Stop).Source
  $orphanTunnel = Start-Process -FilePath $node -ArgumentList $fakeTunnel -WindowStyle Hidden -PassThru
  $orphanMcp = Start-Process -FilePath $node -ArgumentList @($fakeMcp,'--http') -WindowStyle Hidden -PassThru
  Start-Sleep -Milliseconds 300
  [void](Invoke-RwmcpRuntimeConvergence -SupervisorStatePath $statePath -ConnectionStatePath $connectionPath -TargetRoot $newRoot)
  Start-Sleep -Milliseconds 300
  $orphanTunnel.Refresh(); $orphanMcp.Refresh()
  if (-not $orphanTunnel.HasExited) { throw 'Convergence failed to stop orphan openai-tunnel-cli.js.' }
  if (-not $orphanMcp.HasExited) { throw 'Convergence failed to stop orphan dist\cli.js.' }

  $fakeOldRecovery = Join-Path $oldScripts 'autonomous-recovery-windows.ps1'
  $fakeNewRecovery = Join-Path $newScripts 'autonomous-recovery-windows.ps1'
  [IO.File]::WriteAllText($fakeOldRecovery, "Start-Sleep -Seconds 120" + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
  [IO.File]::WriteAllText($fakeNewRecovery, "Start-Sleep -Seconds 120" + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))

  $oldRecovery = Start-Process -FilePath $powershell -ArgumentList @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',$fakeOldRecovery) -WindowStyle Hidden -PassThru
  $newRecovery = Start-Process -FilePath $powershell -ArgumentList @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',$fakeNewRecovery) -WindowStyle Hidden -PassThru
  $duplicateNewRecovery = Start-Process -FilePath $powershell -ArgumentList @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',$fakeNewRecovery) -WindowStyle Hidden -PassThru
  Start-Sleep -Milliseconds 300

  $remainingRecovery = @(Invoke-RwmcpRecoveryPlaneConvergence -TargetRoot $newRoot -KeepProcessId $newRecovery.Id)
  Start-Sleep -Milliseconds 300
  $oldRecovery.Refresh(); $newRecovery.Refresh(); $duplicateNewRecovery.Refresh()
  if (-not $oldRecovery.HasExited) { throw 'Recovery convergence failed to remove the old-slot recovery worker.' }
  if ($newRecovery.HasExited) { throw 'Recovery convergence killed the selected current-slot recovery worker.' }
  if (-not $duplicateNewRecovery.HasExited) { throw 'Recovery convergence failed to remove a duplicate current-slot recovery worker.' }
  if (@($remainingRecovery).Count -ne 1 -or [int]$remainingRecovery[0].ProcessId -ne [int]$newRecovery.Id) {
    throw 'Recovery convergence did not leave exactly the selected current-slot recovery worker.'
  }

  [void](Invoke-RwmcpRecoveryPlaneConvergence -TargetRoot $newRoot)
  Start-Sleep -Milliseconds 300
  $newRecovery.Refresh()
  if (-not $newRecovery.HasExited) { throw 'Recovery convergence without a keeper failed to clear pre-existing recovery workers before Control Center spawn.' }

  Write-Host 'Runtime and recovery-plane convergence helper test passed.' -ForegroundColor Green
} finally {
  foreach ($process in @($host1,$host2,$orphanTunnel,$orphanMcp,$oldRecovery,$newRecovery,$duplicateNewRecovery)) {
    if ($process) {
      try { $process.Refresh(); if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue } } catch {}
      try { $process.Dispose() } catch {}
    }
  }
  $env:LOCALAPPDATA = $savedLocal
  Remove-Item -LiteralPath $tempLocal -Recurse -Force -ErrorAction SilentlyContinue
}
