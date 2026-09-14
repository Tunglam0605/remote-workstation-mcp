$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $Root

. (Join-Path $PSScriptRoot 'windows-settings.ps1')
Apply-RwmcpPersistedEnvironment -Root $Root | Out-Null

$PolicyPath = if ($env:RWMCP_POLICY) { $env:RWMCP_POLICY } else { Join-Path $Root 'config\policy.yaml' }
$HostsPath = if ($env:RWMCP_HOSTS) { $env:RWMCP_HOSTS } else { Join-Path $Root 'config\hosts.yaml' }
$RuntimeDir = Join-Path $Root 'runtime'
$CliPath = Join-Path $Root 'dist\cli.js'
$Port = if ($env:RWMCP_PORT) { $env:RWMCP_PORT } else { '8765' }

if (-not (Test-Path $PolicyPath)) {
  throw "Policy file not found: $PolicyPath. Run the Setup & Control Center first."
}
if (-not (Test-Path $HostsPath)) {
  throw "SSH hosts config not found: $HostsPath. Run the Setup & Control Center first."
}
if (-not (Test-Path $CliPath)) {
  throw "Built runtime not found: $CliPath. Run 'npm run setup:windows' or 'npm run build' first."
}

New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null

$env:RWMCP_POLICY = $PolicyPath
$env:RWMCP_HOSTS = $HostsPath
$env:RWMCP_AUDIT = if ($env:RWMCP_AUDIT) { $env:RWMCP_AUDIT } else { Join-Path $RuntimeDir 'audit.jsonl' }
$env:RWMCP_CLIENT_ID = if ($env:RWMCP_CLIENT_ID) { $env:RWMCP_CLIENT_ID } else { 'windows-local' }
$env:RWMCP_CLIENT_TYPE = if ($env:RWMCP_CLIENT_TYPE) { $env:RWMCP_CLIENT_TYPE } else { 'mcp' }

Write-Host 'Starting Remote Workstation MCP...' -ForegroundColor Green
Write-Host "MCP:    http://127.0.0.1:$Port/mcp"
Write-Host "Health: http://127.0.0.1:$Port/healthz"
Write-Host "Policy: $PolicyPath"
Write-Host "Settings: $(Get-RwmcpSettingsPath)"
Write-Host 'Press Ctrl+C to stop.'

node $CliPath --http
