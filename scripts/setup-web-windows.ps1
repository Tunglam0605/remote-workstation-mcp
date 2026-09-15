$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $Root
$Cli = Join-Path $Root 'dist\setup-web-cli.js'
$Control = Join-Path $Root 'scripts\control-center-windows.ps1'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Node.js 22+ is required. Install Node.js, then run npm run setup:windows.'
}
if (-not (Test-Path $Cli)) {
  Write-Host 'Control Center is not built yet; building runtime...' -ForegroundColor Yellow
  npm run build
  if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }
}

Write-Host 'Opening local Remote Workstation MCP Setup & Control Center...' -ForegroundColor Green
Write-Host 'The Control Center binds only to 127.0.0.1 on its dedicated local port.'
& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $Control -Action Open -Root $Root
if ($LASTEXITCODE -ne 0) { throw 'Failed to start/open the Control Center.' }
