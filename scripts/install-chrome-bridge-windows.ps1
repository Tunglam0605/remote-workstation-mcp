param(
  [string]$RepoRoot = ""
)

$ErrorActionPreference = "Stop"
$ExtensionId = "agffdgankgdnlkmimcojiojbkgneneei"
$HostName = "com.tunglam.rwmcp.chrome_bridge"

if (-not $env:LOCALAPPDATA) { throw "LOCALAPPDATA is unavailable." }
if (-not $RepoRoot) { $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path }
$RepoRoot = (Resolve-Path $RepoRoot).Path

$Launcher = Join-Path $RepoRoot "scripts\chrome-native-host.cmd"
$NativeHostJs = Join-Path $RepoRoot "dist\web\chrome-native-host.js"
$ExtensionPath = Join-Path $RepoRoot "assets\chrome-bridge-extension"

if (-not (Test-Path $Launcher)) { throw "Chrome bridge launcher is missing: $Launcher" }
if (-not (Test-Path $NativeHostJs)) { throw "Build the repository first; native host is missing: $NativeHostJs" }
if (-not (Test-Path (Join-Path $ExtensionPath "manifest.json"))) { throw "Chrome bridge extension is missing: $ExtensionPath" }

$BridgeDir = Join-Path $env:LOCALAPPDATA "RemoteWorkstationMCP\chrome-bridge"
New-Item -ItemType Directory -Force -Path $BridgeDir | Out-Null

$TokenPath = Join-Path $BridgeDir "bridge-token.txt"
if (-not (Test-Path $TokenPath)) {
  $bytes = New-Object byte[] 32
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  $token = [Convert]::ToBase64String($bytes)
  [IO.File]::WriteAllText($TokenPath, $token, (New-Object Text.UTF8Encoding($false)))
}

$ManifestPath = Join-Path $BridgeDir "$HostName.json"
$manifest = [ordered]@{
  name = $HostName
  description = "RWMCP Existing Chrome Bridge native host"
  path = $Launcher
  type = "stdio"
  allowed_origins = @("chrome-extension://$ExtensionId/")
}
$manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $ManifestPath -Encoding UTF8

$RegistryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
New-Item -Path $RegistryPath -Force | Out-Null
Set-Item -Path $RegistryPath -Value $ManifestPath

Write-Output "RWMCP Chrome Bridge native host installed."
Write-Output "ExtensionId=$ExtensionId"
Write-Output "ExtensionPath=$ExtensionPath"
Write-Output "ManifestPath=$ManifestPath"
Write-Output "TokenPath=$TokenPath"
