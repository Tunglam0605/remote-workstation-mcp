function Get-RwmcpUserConfigDir {
  $base = if ($env:LOCALAPPDATA) {
    $env:LOCALAPPDATA
  } elseif ($env:APPDATA) {
    $env:APPDATA
  } else {
    Join-Path $HOME 'AppData\Local'
  }
  return Join-Path $base 'RemoteWorkstationMCP'
}

function Get-RwmcpSettingsPath {
  return Join-Path (Get-RwmcpUserConfigDir) 'settings.json'
}

function Get-RwmcpSecretPath {
  return Join-Path (Get-RwmcpUserConfigDir) 'secrets\openai-runtime-api-key.dpapi'
}

function Import-RwmcpSetupSettings {
  $path = Get-RwmcpSettingsPath
  if (-not (Test-Path $path)) { return $null }
  try {
    return Get-Content -Path $path -Raw | ConvertFrom-Json
  } catch {
    throw "Failed to read persisted Remote Workstation settings at ${path}: $($_.Exception.Message)"
  }
}

function Import-RwmcpRuntimeKey([string]$Root) {
  $secretPath = Get-RwmcpSecretPath
  if (-not (Test-Path $secretPath)) { return $null }
  $secretScript = Join-Path $Root 'scripts\windows-secret.ps1'
  if (-not (Test-Path $secretScript)) { throw "Windows secret helper not found: $secretScript" }
  $value = & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $secretScript -Action Get -Path $secretPath
  if ($LASTEXITCODE -ne 0) { throw 'Failed to decrypt the stored OpenAI runtime API key for the current Windows user.' }
  if ([string]::IsNullOrWhiteSpace($value)) { return $null }
  return $value.Trim()
}

function Apply-RwmcpPersistedEnvironment([string]$Root, [switch]$IncludeOpenAISecret) {
  $settings = Import-RwmcpSetupSettings
  if ($settings) {
    if (-not $env:RWMCP_PORT -and $settings.PSObject.Properties.Name -contains 'mcpPort') {
      $env:RWMCP_PORT = [string]$settings.mcpPort
    }
    if (-not $env:RWMCP_SETUP_PORT -and $settings.PSObject.Properties.Name -contains 'controlPort') {
      $env:RWMCP_SETUP_PORT = [string]$settings.controlPort
    }
    if (-not $env:RWMCP_HTTP_SCOPES -and $settings.PSObject.Properties.Name -contains 'httpScopes' -and $settings.httpScopes) {
      $env:RWMCP_HTTP_SCOPES = (@($settings.httpScopes) -join ',')
    }
    if (-not $env:CONTROL_PLANE_TUNNEL_ID -and $settings.PSObject.Properties.Name -contains 'tunnelId' -and $settings.tunnelId) {
      $env:CONTROL_PLANE_TUNNEL_ID = [string]$settings.tunnelId
    }
    if (-not $env:CONTROL_PLANE_ORGANIZATION_ID -and $settings.PSObject.Properties.Name -contains 'organizationId' -and $settings.organizationId) {
      $env:CONTROL_PLANE_ORGANIZATION_ID = [string]$settings.organizationId
    }
    if (-not $env:CLOUDFLARED_MANAGED -and $settings.PSObject.Properties.Name -contains 'cloudflaredManaged') {
      $env:CLOUDFLARED_MANAGED = if ([bool]$settings.cloudflaredManaged) { 'true' } else { 'false' }
    }
  }
  if (-not $env:RWMCP_SETUP_PORT) { $env:RWMCP_SETUP_PORT = '8684' }
  if (-not $env:RWMCP_LEASE) {
    $env:RWMCP_LEASE = Join-Path (Get-RwmcpUserConfigDir) 'runtime\permission-lease.json'
  }
  if ($IncludeOpenAISecret -and -not $env:CONTROL_PLANE_API_KEY) {
    $stored = Import-RwmcpRuntimeKey -Root $Root
    if ($stored) { $env:CONTROL_PLANE_API_KEY = $stored }
  }
  return $settings
}
