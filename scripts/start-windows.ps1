$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $Root

$PolicyPath = Join-Path $Root 'config\policy.yaml'
$HostsPath = Join-Path $Root 'config\hosts.yaml'
$RuntimeDir = Join-Path $Root 'runtime'
$CliPath = Join-Path $Root 'dist\cli.js'

if (-not (Test-Path $PolicyPath)) {
  throw "Policy file not found: $PolicyPath. Run 'npm run setup:windows' first."
}
if (-not (Test-Path $CliPath)) {
  throw "Built runtime not found: $CliPath. Run 'npm run setup:windows' or 'npm run build' first."
}

New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null

$env:RWMCP_POLICY = $PolicyPath
$env:RWMCP_HOSTS = $HostsPath
$env:RWMCP_AUDIT = Join-Path $RuntimeDir 'audit.jsonl'
$env:RWMCP_CLIENT_ID = if ($env:RWMCP_CLIENT_ID) { $env:RWMCP_CLIENT_ID } else { 'windows-local' }
$env:RWMCP_CLIENT_TYPE = if ($env:RWMCP_CLIENT_TYPE) { $env:RWMCP_CLIENT_TYPE } else { 'mcp' }

Write-Host 'Starting Remote Workstation MCP...' -ForegroundColor Green
Write-Host 'MCP:    http://127.0.0.1:8765/mcp'
Write-Host 'Health: http://127.0.0.1:8765/healthz'
Write-Host 'Press Ctrl+C to stop.'

node $CliPath --http
