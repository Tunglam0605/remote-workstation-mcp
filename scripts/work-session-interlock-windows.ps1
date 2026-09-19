Set-StrictMode -Version Latest

function Get-RwmcpWorkSessionInterlockPath {
  if (Get-Command Get-RwmcpUserConfigDir -ErrorAction SilentlyContinue) {
    return Join-Path (Get-RwmcpUserConfigDir) 'runtime\work-session-interlocks.json'
  }
  $localBase = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } elseif ($env:APPDATA) { $env:APPDATA } else { Join-Path $HOME 'AppData\Local' }
  return Join-Path $localBase 'RemoteWorkstationMCP\runtime\work-session-interlocks.json'
}

function Get-RwmcpActiveWorkSessionInterlocks {
  $path = Get-RwmcpWorkSessionInterlockPath
  if (-not (Test-Path -LiteralPath $path)) { return @() }
  try {
    $state = Get-Content -LiteralPath $path -Raw -ErrorAction Stop | ConvertFrom-Json
  } catch {
    throw "Work Session interlock state is unreadable; refusing lifecycle mutation: $($_.Exception.Message)"
  }
  if (-not $state -or [int]$state.version -ne 1 -or -not ($state.PSObject.Properties.Name -contains 'records')) {
    throw 'Work Session interlock state is invalid; refusing lifecycle mutation.'
  }

  $active = @()
  foreach ($record in @($state.records)) {
    $pidValue = 0
    try { $pidValue = [int]$record.pid } catch { continue }
    if ($pidValue -le 0) { continue }
    try {
      $process = Get-Process -Id $pidValue -ErrorAction Stop
      if ($process) { $active += $record }
    } catch {}
  }
  return @($active)
}

function Assert-NoRwmcpActiveWorkSessionInterlocks {
  param([string]$Operation = 'node lifecycle mutation')
  $active = @(Get-RwmcpActiveWorkSessionInterlocks)
  if ($active.Count -eq 0) { return }
  $labels = @($active | Select-Object -First 5 | ForEach-Object { [string]$_.label }) -join ', '
  if (-not $labels) { $labels = 'workflow' }
  throw "NODE_BUSY: $($active.Count) active Work Session workflow interlock(s) prevent $Operation. Active: $labels. Finish/cancel the typed workflow first; lifecycle operations do not implicitly override critical work."
}
