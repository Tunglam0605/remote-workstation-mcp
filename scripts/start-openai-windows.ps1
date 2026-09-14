$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $Root

$PolicyPath = Join-Path $Root 'config\policy.yaml'
$HostsPath = Join-Path $Root 'config\hosts.yaml'
$RuntimeDir = Join-Path $Root 'runtime'
$SupervisorPath = Join-Path $Root 'dist\openai-tunnel-cli.js'
$TunnelBinary = Join-Path $Root 'runtime\openai-tunnel\tunnel-client.exe'

if (-not (Test-Path $PolicyPath)) {
  throw "Policy file not found: $PolicyPath. Run 'npm run setup:windows' first."
}
if (-not (Test-Path $SupervisorPath)) {
  throw "Built OpenAI tunnel supervisor not found: $SupervisorPath. Run 'npm run build' first."
}
if (-not (Test-Path $TunnelBinary)) {
  throw "OpenAI tunnel-client is not installed. Run 'npm run openai:tunnel:install:windows' first."
}
if (-not $env:CONTROL_PLANE_TUNNEL_ID) {
  throw 'CONTROL_PLANE_TUNNEL_ID is required. Create/select a tunnel in OpenAI Platform Tunnels and set it in this PowerShell session.'
}
if (-not $env:CONTROL_PLANE_API_KEY) {
  throw 'CONTROL_PLANE_API_KEY is required. Set a runtime API key with Tunnels Read + Use permission in this PowerShell session.'
}

New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null

$env:RWMCP_POLICY = $PolicyPath
$env:RWMCP_HOSTS = $HostsPath
$env:RWMCP_AUDIT = Join-Path $RuntimeDir 'audit.jsonl'
$env:RWMCP_CLIENT_ID = if ($env:RWMCP_CLIENT_ID) { $env:RWMCP_CLIENT_ID } else { 'openai-tunnel' }
$env:RWMCP_CLIENT_TYPE = if ($env:RWMCP_CLIENT_TYPE) { $env:RWMCP_CLIENT_TYPE } else { 'chatgpt' }
$env:RWMCP_OPENAI_TUNNEL_CLIENT = $TunnelBinary

Write-Host 'Starting Remote Workstation MCP behind OpenAI Secure MCP Tunnel...' -ForegroundColor Green
Write-Host 'Local MCP stays loopback-only: http://127.0.0.1:8765/mcp'
Write-Host 'The supervisor generates a fresh local MCP bearer token unless you explicitly provide RWMCP_HTTP_BEARER_TOKEN.'
Write-Host 'The OpenAI runtime API key is not forwarded into the MCP child process.'
Write-Host 'Press Ctrl+C to stop both processes.'
Write-Host ''

node $SupervisorPath
