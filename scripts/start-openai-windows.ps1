$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $Root

. (Join-Path $PSScriptRoot 'windows-settings.ps1')
Apply-RwmcpPersistedEnvironment -Root $Root -IncludeOpenAISecret | Out-Null

$PolicyPath = if ($env:RWMCP_POLICY) { $env:RWMCP_POLICY } else { Join-Path $Root 'config\policy.yaml' }
$HostsPath = if ($env:RWMCP_HOSTS) { $env:RWMCP_HOSTS } else { Join-Path $Root 'config\hosts.yaml' }
$RuntimeDir = Join-Path $Root 'runtime'
$SupervisorPath = Join-Path $Root 'dist\openai-tunnel-cli.js'
$TunnelBinary = if ($env:RWMCP_OPENAI_TUNNEL_CLIENT) { $env:RWMCP_OPENAI_TUNNEL_CLIENT } else { Join-Path $Root 'runtime\openai-tunnel\tunnel-client.exe' }
$Port = if ($env:RWMCP_PORT) { $env:RWMCP_PORT } else { '8683' }

if (-not (Test-Path $PolicyPath)) {
  throw "Policy file not found: $PolicyPath. Run the Setup & Control Center first."
}
if (-not (Test-Path $HostsPath)) {
  throw "SSH hosts config not found: $HostsPath. Run the Setup & Control Center first."
}
if (-not (Test-Path $SupervisorPath)) {
  throw "Built OpenAI tunnel supervisor not found: $SupervisorPath. Run 'npm run build' first."
}
if (-not (Test-Path $TunnelBinary)) {
  throw "OpenAI tunnel-client is not installed. Run 'npm run openai:tunnel:install:windows' or install it from the Setup & Control Center."
}
if (-not $env:CONTROL_PLANE_TUNNEL_ID) {
  throw 'CONTROL_PLANE_TUNNEL_ID is required. Save it in the Setup & Control Center or set it in this PowerShell session.'
}
if (-not $env:CONTROL_PLANE_API_KEY) {
  throw 'CONTROL_PLANE_API_KEY is required. Save it with Windows DPAPI in the Setup & Control Center or set it in this PowerShell session.'
}

New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null

$env:RWMCP_POLICY = $PolicyPath
$env:RWMCP_HOSTS = $HostsPath
$env:RWMCP_AUDIT = if ($env:RWMCP_AUDIT) { $env:RWMCP_AUDIT } else { Join-Path $RuntimeDir 'audit.jsonl' }
$env:RWMCP_CLIENT_ID = if ($env:RWMCP_CLIENT_ID) { $env:RWMCP_CLIENT_ID } else { 'openai-tunnel' }
$env:RWMCP_CLIENT_TYPE = if ($env:RWMCP_CLIENT_TYPE) { $env:RWMCP_CLIENT_TYPE } else { 'chatgpt' }
$env:RWMCP_OPENAI_TUNNEL_CLIENT = $TunnelBinary

if (-not $env:CLOUDFLARED_MANAGED) {
  $env:CLOUDFLARED_MANAGED = 'false'
}

Write-Host 'Starting Remote Workstation MCP behind OpenAI Secure MCP Tunnel...' -ForegroundColor Green
Write-Host "Local MCP stays loopback-only: http://127.0.0.1:$Port/mcp"
Write-Host "Cloudflared managed runtime: $($env:CLOUDFLARED_MANAGED)"
if ($env:CONTROL_PLANE_ORGANIZATION_ID) {
  Write-Host "OpenAI organization context: $($env:CONTROL_PLANE_ORGANIZATION_ID)"
}
Write-Host "Policy: $PolicyPath"
Write-Host "Settings: $(Get-RwmcpSettingsPath)"
Write-Host 'The supervisor generates a fresh local MCP bearer token unless you explicitly provide RWMCP_HTTP_BEARER_TOKEN.'
Write-Host 'The OpenAI runtime API key is not forwarded into the MCP child process.'
Write-Host 'Press Ctrl+C to stop both processes.'
Write-Host ''

node $SupervisorPath
