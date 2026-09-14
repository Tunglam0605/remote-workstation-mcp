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

function Require-OrInstall([string]$Command, [string]$WingetId) {
  if (Get-Command $Command -ErrorAction SilentlyContinue) { return }
  if ($SkipPrerequisites) { throw "Required command '$Command' is missing." }
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if (-not $winget) {
    throw "Required command '$Command' is missing and winget is unavailable. Install $WingetId, then rerun this installer."
  }
  Write-Host "Installing prerequisite $WingetId..." -ForegroundColor Cyan
  & $winget.Source install --id $WingetId -e --accept-source-agreements --accept-package-agreements
  if ($LASTEXITCODE -ne 0) { throw "winget failed to install $WingetId (exit $LASTEXITCODE)." }
  Refresh-Path
  if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) {
    throw "$WingetId was installed but '$Command' is still unavailable in this session. Open a new PowerShell window and rerun the installer."
  }
}

function Write-StableLauncher([string]$CurrentRoot) {
  $launcher = Join-Path $BinDir 'rwmcp.ps1'
  $content = @'
param(
  [ValidateSet('Setup','Start','StartOpenAI','Stop','Restart','Status','AutostartOn','AutostartOff','Update','Rollback')]
  [string]$Action = 'Setup'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$Base = Split-Path -Parent $PSScriptRoot
$CurrentFile = Join-Path $Base 'current.txt'
if (-not (Test-Path $CurrentFile)) { throw 'Remote Workstation MCP current runtime pointer is missing.' }
$Root = (Get-Content -Path $CurrentFile -Raw).Trim()
if (-not (Test-Path $Root)) { throw "Installed runtime does not exist: $Root" }
$env:RWMCP_POLICY = Join-Path $Base 'config\policy.yaml'
$env:RWMCP_HOSTS = Join-Path $Base 'config\hosts.yaml'
switch ($Action) {
  'Setup' { & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root 'scripts\setup-web-windows.ps1') }
  'Start' { & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root 'scripts\runtime-control-windows.ps1') -Action Start -Mode Local -Root $Root }
  'StartOpenAI' { & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root 'scripts\runtime-control-windows.ps1') -Action Start -Mode OpenAI -Root $Root }
  'Stop' { & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root 'scripts\runtime-control-windows.ps1') -Action Stop -Root $Root }
  'Restart' { & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root 'scripts\runtime-control-windows.ps1') -Action Restart -Mode OpenAI -Root $Root }
  'Status' { & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root 'scripts\runtime-control-windows.ps1') -Action Status -Root $Root }
  'AutostartOn' { & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root 'scripts\runtime-control-windows.ps1') -Action RegisterStartup -Mode OpenAI -Root $Root }
  'AutostartOff' { & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root 'scripts\runtime-control-windows.ps1') -Action UnregisterStartup -Root $Root }
  'Update' { & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Base 'bin\install-windows-release.ps1') -NoSetup }
  'Rollback' { & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Base 'bin\install-windows-release.ps1') -Rollback -NoSetup }
}
'@
  Set-Content -Path $launcher -Value $content -Encoding utf8
  Copy-Item -Path (Join-Path $CurrentRoot 'scripts\install-windows-release.ps1') -Destination (Join-Path $BinDir 'install-windows-release.ps1') -Force
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

Require-OrInstall 'node' 'OpenJS.NodeJS.LTS'
Require-OrInstall 'npm' 'OpenJS.NodeJS.LTS'
Require-OrInstall 'git' 'Git.Git'
if (-not (Get-Command tar.exe -ErrorAction SilentlyContinue)) {
  throw 'Windows tar.exe is required to extract the verified release package.'
}

$nodeVersion = (& node --version).TrimStart('v')
$nodeMajor = [int]($nodeVersion.Split('.')[0])
if ($nodeMajor -lt 22) { throw "Node.js 22+ is required. Found v$nodeVersion." }

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

  & tar.exe -xzf $PackagePath -C $StageDir
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
      & npm install --omit=dev --no-audit --no-fund --ignore-scripts
      if ($LASTEXITCODE -ne 0) { throw "npm install failed (exit $LASTEXITCODE)." }
      $reportedVersion = (& node dist/cli.js --version 2>&1 | Out-String).Trim()
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
