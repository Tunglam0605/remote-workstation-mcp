param(
  [string]$Version = 'latest',
  [switch]$SkipPrerequisites,
  [switch]$NoSetup,
  [switch]$Rollback
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Repo = 'Tunglam0605/remote-workstation-mcp'
$LocalBase = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $HOME 'AppData\Local' }
$Base = Join-Path $LocalBase 'RemoteWorkstationMCP'
$VersionsDir = Join-Path $Base 'versions'
$BinDir = Join-Path $Base 'bin'
$ConfigDir = Join-Path $Base 'config'
$CurrentFile = Join-Path $Base 'current.txt'
$PreviousFile = Join-Path $Base 'previous.txt'
New-Item -ItemType Directory -Force -Path $Base, $VersionsDir, $BinDir, $ConfigDir | Out-Null

function Refresh-Path {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = @($machine, $user) -join ';'
}

function Resolve-CommandPath([string]$Command, [string]$WingetId, [string[]]$KnownPaths = @()) {
  $existing = Get-Command $Command -ErrorAction SilentlyContinue
  if ($existing) { return $existing.Source }
  foreach ($candidate in $KnownPaths) {
    if ($candidate -and (Test-Path $candidate)) { return $candidate }
  }
  if ($SkipPrerequisites) { throw "Required command '$Command' is missing." }
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if (-not $winget) {
    throw "Required command '$Command' is missing and winget is unavailable. Install $WingetId, then rerun this installer."
  }
  Write-Host "Installing prerequisite $WingetId..." -ForegroundColor Cyan
  & $winget.Source install --id $WingetId -e --accept-source-agreements --accept-package-agreements --silent
  if ($LASTEXITCODE -ne 0) { throw "winget failed to install $WingetId (exit $LASTEXITCODE)." }
  Refresh-Path
  $installed = Get-Command $Command -ErrorAction SilentlyContinue
  if ($installed) { return $installed.Source }
  foreach ($candidate in $KnownPaths) {
    if ($candidate -and (Test-Path $candidate)) { return $candidate }
  }
  throw "$WingetId was installed but '$Command' could not be located. Restart Windows and retry only if the installer cannot continue automatically."
}

function Write-StableLauncher([string]$CurrentRoot) {
  $launcher = Join-Path $BinDir 'rwmcp.ps1'
  $content = @'
param(
  [ValidateSet('Setup','Start','StartOpenAI','Boot','Stop','Restart','Status','AutostartOn','AutostartOff','Update','UpdateCheck','AutoUpdateOn','AutoUpdateOff','Rollback')]
  [string]$Action = 'Setup'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$Base = Split-Path -Parent $PSScriptRoot
$CurrentFile = Join-Path $Base 'current.txt'
$PreviousFile = Join-Path $Base 'previous.txt'
$Installer = Join-Path $Base 'bin\install-windows-release.ps1'
$Updater = Join-Path $Base 'bin\update-windows.ps1'
$env:RWMCP_POLICY = Join-Path $Base 'config\policy.yaml'
$env:RWMCP_HOSTS = Join-Path $Base 'config\hosts.yaml'

function Get-CurrentRoot {
  if (-not (Test-Path $CurrentFile)) { throw 'Remote Workstation MCP current runtime pointer is missing.' }
  $root = (Get-Content -Path $CurrentFile -Raw).Trim()
  if (-not (Test-Path $root)) { throw "Installed runtime does not exist: $root" }
  return $root
}

function Get-RootVersion([string]$Root) {
  try {
    $manifest = Get-Content -Path (Join-Path $Root 'package.json') -Raw | ConvertFrom-Json
    return [string]$manifest.version
  } catch { return '' }
}

function Cleanup-VersionSlots {
  try {
    $versionsDir = Join-Path $Base 'versions'
    if (-not (Test-Path $versionsDir)) { return }
    $protected = @()
    foreach ($pointer in @($CurrentFile, $PreviousFile)) {
      if (-not (Test-Path $pointer)) { continue }
      $value = (Get-Content -Path $pointer -Raw).Trim()
      if ($value -and (Test-Path $value)) { $protected += [IO.Path]::GetFullPath($value) }
    }
    $extraKept = 0
    $dirs = @(Get-ChildItem -LiteralPath $versionsDir -Directory -ErrorAction SilentlyContinue | Sort-Object LastWriteTimeUtc -Descending)
    foreach ($dir in $dirs) {
      $full = [IO.Path]::GetFullPath($dir.FullName)
      $isProtected = $false
      foreach ($keep in $protected) {
        if ([string]::Equals($full, $keep, [StringComparison]::OrdinalIgnoreCase)) { $isProtected = $true; break }
      }
      if ($isProtected) { continue }
      # Keep one additional older slot besides current + previous for emergency
      # inspection while bounding long-term disk growth from automatic updates.
      if ($extraKept -lt 1) { $extraKept += 1; continue }
      Remove-Item -LiteralPath $full -Recurse -Force -ErrorAction Stop
    }
  } catch {
    Write-Warning "Old version-slot cleanup was skipped: $($_.Exception.Message)"
  }
}

function Invoke-Runtime([string]$RuntimeAction, [string]$Mode = 'OpenAI', [string]$Root = '') {
  if (-not $Root) { $Root = Get-CurrentRoot }
  $script = Join-Path $Root 'scripts\runtime-control-windows.ps1'
  if ($RuntimeAction -in @('Start','Restart','RegisterStartup')) {
    & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $script -Action $RuntimeAction -Mode $Mode -Root $Root
  } else {
    & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $script -Action $RuntimeAction -Root $Root
  }
  if ($LASTEXITCODE -ne 0) { throw "Runtime action $RuntimeAction failed with exit code $LASTEXITCODE." }
}

function Invoke-Updater([string]$UpdateAction, [switch]$Quiet) {
  if (-not (Test-Path $Updater)) { return }
  $args = @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',$Updater,'-Action',$UpdateAction)
  if ($Quiet) { $args += '-Quiet' }
  & powershell.exe @args
  if ($LASTEXITCODE -ne 0) { throw "Updater action $UpdateAction failed with exit code $LASTEXITCODE." }
}

function Invoke-SafeBoot {
  $before = Get-CurrentRoot
  try {
    Invoke-Updater 'InstallAuto' -Quiet
  } catch {
    Write-Warning "Automatic update check failed; starting the installed version: $($_.Exception.Message)"
  }
  $candidate = Get-CurrentRoot
  try {
    Invoke-Runtime 'Start' 'OpenAI' $candidate
    Cleanup-VersionSlots
  } catch {
    if (-not [string]::Equals($candidate, $before, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path $PreviousFile)) {
      $failedVersion = Get-RootVersion $candidate
      if ($failedVersion -and (Test-Path $Updater)) {
        try { & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $Updater -Action MarkFailed -Version $failedVersion -Quiet | Out-Null } catch {}
      }
      Write-Warning "Updated runtime failed health/readiness checks. Rolling back to the previous slot."
      & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $Installer -Rollback -NoSetup
      if ($LASTEXITCODE -ne 0) { throw 'Automatic rollback failed.' }
      Invoke-Runtime 'Start' 'OpenAI' (Get-CurrentRoot)
      return
    }
    throw
  }
}

$Root = Get-CurrentRoot
switch ($Action) {
  'Setup' { & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root 'scripts\setup-web-windows.ps1') }
  'Start' { Invoke-Runtime 'Start' 'Local' $Root }
  'StartOpenAI' { Invoke-Runtime 'Start' 'OpenAI' $Root }
  'Boot' { Invoke-SafeBoot }
  'Stop' { Invoke-Runtime 'Stop' 'OpenAI' $Root }
  'Restart' {
    $safeRestart = Join-Path $Root 'scripts\safe-restart-windows.ps1'
    & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $safeRestart -Root $Root -Mode OpenAI
    if ($LASTEXITCODE -ne 0) { throw "Safe runtime restart failed with exit code $LASTEXITCODE." }
  }
  'Status' { Invoke-Runtime 'Status' 'OpenAI' $Root }
  'AutostartOn' { Invoke-Runtime 'RegisterStartup' 'OpenAI' $Root }
  'AutostartOff' { Invoke-Runtime 'UnregisterStartup' 'OpenAI' $Root }
  'UpdateCheck' { Invoke-Updater 'Check' }
  'AutoUpdateOn' { Invoke-Updater 'Enable' }
  'AutoUpdateOff' { Invoke-Updater 'Disable' }
  'Update' {
    $before = Get-CurrentRoot
    try { Invoke-Runtime 'Stop' 'OpenAI' $before } catch {}
    Invoke-Updater 'Install'
    $candidate = Get-CurrentRoot
    try {
      Invoke-Runtime 'Start' 'OpenAI' $candidate
      Cleanup-VersionSlots
    } catch {
      $failedVersion = Get-RootVersion $candidate
      if ($failedVersion -and (Test-Path $Updater)) {
        try { & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $Updater -Action MarkFailed -Version $failedVersion -Quiet | Out-Null } catch {}
      }
      if (Test-Path $PreviousFile) {
        & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $Installer -Rollback -NoSetup
        if ($LASTEXITCODE -eq 0) { Invoke-Runtime 'Start' 'OpenAI' (Get-CurrentRoot) }
      }
      throw
    }
  }
  'Rollback' {
    try { Invoke-Runtime 'Stop' 'OpenAI' $Root } catch {}
    & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $Installer -Rollback -NoSetup
    if ($LASTEXITCODE -ne 0) { throw 'Rollback failed.' }
    Invoke-Runtime 'Start' 'OpenAI' (Get-CurrentRoot)
  }
}
'@
  [IO.File]::WriteAllText($launcher, $content + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
  # Prefer the launcher shipped by the newly installed runtime slot. This prevents
  # an older installer from leaving an older stable launcher behind after upgrade.
  $launcherTemplate = Join-Path $CurrentRoot 'scripts\rwmcp-launcher-windows.ps1'
  if (Test-Path $launcherTemplate) { Copy-Item -Path $launcherTemplate -Destination $launcher -Force }
  Copy-Item -Path (Join-Path $CurrentRoot 'scripts\install-windows-release.ps1') -Destination (Join-Path $BinDir 'install-windows-release.ps1') -Force
  $updateScript = Join-Path $CurrentRoot 'scripts\update-windows.ps1'
  if (Test-Path $updateScript) { Copy-Item -Path $updateScript -Destination (Join-Path $BinDir 'update-windows.ps1') -Force }
}

function Install-Shortcut {
  try {
    $programs = [Environment]::GetFolderPath('Programs')
    $shortcutPath = Join-Path $programs 'Remote Workstation MCP.lnk'
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = 'powershell.exe'
    $launcher = Join-Path $BinDir 'rwmcp.ps1'
    $shortcut.Arguments = "-NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$launcher`" -Action Setup"
    $shortcut.WorkingDirectory = $Base
    $shortcut.Description = 'Remote Workstation MCP Setup & Control Center'
    $shortcut.Save()
  } catch {
    Write-Host "Start Menu shortcut was not created: $($_.Exception.Message)" -ForegroundColor Yellow
  }
}

function Initialize-AutoUpdate {
  $updater = Join-Path $BinDir 'update-windows.ps1'
  $updateState = Join-Path $Base 'update.json'
  if (-not (Test-Path $updater)) { return }
  if (Test-Path $updateState) { return }
  try {
    & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $updater -Action Enable -Quiet
    if ($LASTEXITCODE -ne 0) { throw "Updater initialization failed with exit code $LASTEXITCODE." }
  } catch {
    Write-Host "Automatic stable updates could not be initialized: $($_.Exception.Message)" -ForegroundColor Yellow
  }
}

function Migrate-ExistingAutostart {
  $runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
  $runName = 'RemoteWorkstationMCP'
  try {
    $existing = Get-ItemProperty -Path $runKey -Name $runName -ErrorAction Stop
    if ([string]::IsNullOrWhiteSpace([string]$existing.$runName)) { return }
    $launcher = Join-Path $BinDir 'rwmcp.ps1'
    $command = "powershell.exe -NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$launcher`" -Action Boot"
    New-Item -Path $runKey -Force | Out-Null
    New-ItemProperty -Path $runKey -Name $runName -Value $command -PropertyType String -Force | Out-Null
  } catch {
    # No existing registration means this is a first-time install. The setup
    # wizard will enable start-at-logon only after configuration succeeds.
  }
}

if ($Rollback) {
  if (-not (Test-Path $PreviousFile)) { throw 'No previous installed version is available for rollback.' }
  $previous = (Get-Content -Path $PreviousFile -Raw).Trim()
  if (-not (Test-Path $previous)) { throw "Previous runtime slot does not exist: $previous" }
  $current = if (Test-Path $CurrentFile) { (Get-Content -Path $CurrentFile -Raw).Trim() } else { '' }
  Set-Content -Path $CurrentFile -Value $previous -Encoding utf8
  if ($current) { Set-Content -Path $PreviousFile -Value $current -Encoding utf8 }
  Write-StableLauncher $previous
  Write-Host "Rolled back current runtime to: $previous" -ForegroundColor Green
  exit 0
}

$nodeKnown = @((Join-Path $env:ProgramFiles 'nodejs\node.exe'))
$npmKnown = @((Join-Path $env:ProgramFiles 'nodejs\npm.cmd'))
$gitKnown = @((Join-Path $env:ProgramFiles 'Git\cmd\git.exe'))
if (${env:ProgramFiles(x86)}) { $gitKnown += (Join-Path ${env:ProgramFiles(x86)} 'Git\cmd\git.exe') }
if ($env:LOCALAPPDATA) { $gitKnown += (Join-Path $env:LOCALAPPDATA 'Programs\Git\cmd\git.exe') }
$NodeExe = Resolve-CommandPath 'node' 'OpenJS.NodeJS.LTS' $nodeKnown
$NpmExe = Resolve-CommandPath 'npm' 'OpenJS.NodeJS.LTS' $npmKnown
# Git is not required by the updater itself, but it backs the built-in Git MCP
# tools. Install it automatically on a new engineering workstation so the
# one-time setup yields the complete default capability set.
$GitExe = Resolve-CommandPath 'git' 'Git.Git' $gitKnown
$TarExe = (Get-Command tar.exe -ErrorAction SilentlyContinue).Source
if (-not $TarExe) { throw 'Windows tar.exe is required to extract the verified release package.' }

$nodeVersion = (& $NodeExe --version).TrimStart('v')
$nodeMajor = [int]($nodeVersion.Split('.')[0])
if ($nodeMajor -lt 22) {
  if ($SkipPrerequisites) { throw "Node.js 22+ is required. Found v$nodeVersion." }
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if (-not $winget) { throw "Node.js 22+ is required. Found v$nodeVersion and winget is unavailable for automatic upgrade." }
  Write-Host "Upgrading Node.js LTS (found v$nodeVersion)..." -ForegroundColor Cyan
  & $winget.Source upgrade --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements --silent
  if ($LASTEXITCODE -ne 0) {
    # Some winget states report no installed package to upgrade; install is safe/idempotent.
    & $winget.Source install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements --silent
    if ($LASTEXITCODE -ne 0) { throw "winget failed to upgrade Node.js LTS (exit $LASTEXITCODE)." }
  }
  Refresh-Path
  $NodeExe = Resolve-CommandPath 'node' 'OpenJS.NodeJS.LTS' $nodeKnown
  $NpmExe = Resolve-CommandPath 'npm' 'OpenJS.NodeJS.LTS' $npmKnown
  $nodeVersion = (& $NodeExe --version).TrimStart('v')
  $nodeMajor = [int]($nodeVersion.Split('.')[0])
  if ($nodeMajor -lt 22) { throw "Node.js upgrade completed but v$nodeVersion is still below required v22." }
}

$headers = @{ 'User-Agent' = 'remote-workstation-mcp-windows-installer' }
$releaseUri = if ($Version -eq 'latest') {
  "https://api.github.com/repos/$Repo/releases/latest"
} else {
  $tag = if ($Version.StartsWith('v')) { $Version } else { "v$Version" }
  "https://api.github.com/repos/$Repo/releases/tags/$tag"
}
Write-Host "Resolving Remote Workstation MCP release ($Version)..." -ForegroundColor Cyan
$release = Invoke-RestMethod -Uri $releaseUri -Headers $headers -UseBasicParsing
$tagName = [string]$release.tag_name
if ($tagName -notmatch '^v\d+\.\d+\.\d+$') { throw "Unexpected release tag: $tagName" }
$assetName = "remote-workstation-mcp-$tagName.tgz"
$packageAsset = @($release.assets | Where-Object { $_.name -eq $assetName }) | Select-Object -First 1
$sumAsset = @($release.assets | Where-Object { $_.name -eq 'SHA256SUMS.txt' }) | Select-Object -First 1
if (-not $packageAsset -or -not $sumAsset) { throw "Release $tagName is missing required package/checksum assets." }

$TempDir = Join-Path ([IO.Path]::GetTempPath()) ("rwmcp-install-" + [Guid]::NewGuid().ToString('N'))
$PackagePath = Join-Path $TempDir $assetName
$SumPath = Join-Path $TempDir 'SHA256SUMS.txt'
$StageDir = Join-Path $TempDir 'stage'
New-Item -ItemType Directory -Force -Path $TempDir, $StageDir | Out-Null

try {
  Write-Host "Downloading $assetName..."
  Invoke-WebRequest -Uri $packageAsset.browser_download_url -OutFile $PackagePath -Headers $headers -UseBasicParsing
  Invoke-WebRequest -Uri $sumAsset.browser_download_url -OutFile $SumPath -Headers $headers -UseBasicParsing
  $sumLine = Get-Content -Path $SumPath | Where-Object { $_ -match [regex]::Escape($assetName) } | Select-Object -First 1
  if (-not $sumLine -or $sumLine -notmatch '^([0-9a-fA-F]{64})\s+') { throw 'SHA256SUMS.txt does not contain a valid checksum for the release package.' }
  $expected = $Matches[1].ToLowerInvariant()
  $actual = (Get-FileHash -Path $PackagePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $expected) { throw "Release package SHA-256 mismatch. Expected $expected but got $actual." }
  Write-Host "SHA-256 verified: $actual" -ForegroundColor Green

  & $TarExe -xzf $PackagePath -C $StageDir
  if ($LASTEXITCODE -ne 0) { throw "tar.exe failed to extract the release package (exit $LASTEXITCODE)." }
  $packageDir = Join-Path $StageDir 'package'
  if (-not (Test-Path (Join-Path $packageDir 'package.json'))) { throw 'Extracted release package is missing package.json.' }
  $manifest = Get-Content -Path (Join-Path $packageDir 'package.json') -Raw | ConvertFrom-Json
  if ("v$($manifest.version)" -ne $tagName) { throw "Release manifest version $($manifest.version) does not match $tagName." }

  $Slot = Join-Path $VersionsDir $tagName
  if (-not (Test-Path $Slot)) {
    Write-Host "Installing runtime slot $Slot..." -ForegroundColor Cyan
    Move-Item -Path $packageDir -Destination $Slot
    Push-Location $Slot
    try {
      & $NpmExe install --omit=dev --no-audit --no-fund --ignore-scripts
      if ($LASTEXITCODE -ne 0) { throw "npm install failed (exit $LASTEXITCODE)." }
      $reportedVersion = (& $NodeExe dist/cli.js --version 2>&1 | Out-String).Trim()
      if ($LASTEXITCODE -ne 0 -or $reportedVersion -notmatch [regex]::Escape($manifest.version)) {
        throw "Installed runtime version check failed: $reportedVersion"
      }
      & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Slot 'scripts\install-openai-tunnel-windows.ps1')
      if ($LASTEXITCODE -ne 0) { throw 'OpenAI tunnel-client installation failed.' }
    } finally { Pop-Location }
  } else {
    Write-Host "Runtime slot already exists: $Slot" -ForegroundColor Yellow
  }

  $oldCurrent = if (Test-Path $CurrentFile) { (Get-Content -Path $CurrentFile -Raw).Trim() } else { '' }
  if ($oldCurrent -and $oldCurrent -ne $Slot -and (Test-Path $oldCurrent)) {
    Set-Content -Path $PreviousFile -Value $oldCurrent -Encoding utf8
  }
  Set-Content -Path $CurrentFile -Value $Slot -Encoding utf8
  Write-StableLauncher $Slot
  Install-Shortcut
  Initialize-AutoUpdate
  Migrate-ExistingAutostart

  $env:RWMCP_POLICY = Join-Path $ConfigDir 'policy.yaml'
  $env:RWMCP_HOSTS = Join-Path $ConfigDir 'hosts.yaml'

  Write-Host ''
  Write-Host "Remote Workstation MCP $tagName installed." -ForegroundColor Green
  Write-Host "Current runtime: $Slot"
  Write-Host "Control launcher: $(Join-Path $BinDir 'rwmcp.ps1')"
  if (Test-Path $PreviousFile) { Write-Host "Rollback slot: $((Get-Content $PreviousFile -Raw).Trim())" }

  if (-not $NoSetup) {
    Write-Host 'Opening the local Setup & Control Center...' -ForegroundColor Cyan
    & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $BinDir 'rwmcp.ps1') -Action Setup
  }
} finally {
  Remove-Item -Path $TempDir -Recurse -Force -ErrorAction SilentlyContinue
}
