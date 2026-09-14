$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $Root

Write-Host 'Remote Workstation MCP - Windows first run' -ForegroundColor Green
Write-Host 'Phase 1/2: validate, install dependencies, test and build.'
& (Join-Path $PSScriptRoot 'setup-windows.ps1')
if ($LASTEXITCODE -ne 0) { throw 'Windows runtime setup failed.' }

Write-Host ''
Write-Host 'Phase 2/2: open the local Setup Console.'
& (Join-Path $PSScriptRoot 'setup-web-windows.ps1')
