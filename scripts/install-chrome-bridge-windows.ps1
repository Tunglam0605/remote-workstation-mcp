param(
  [string]$RepoRoot = ""
)

$ErrorActionPreference = "Stop"
$ExtensionId = "agffdgankgdnlkmimcojiojbkgneneei"
$HostName = "com.tunglam.rwmcp.chrome_bridge"

if (-not $env:LOCALAPPDATA) { throw "LOCALAPPDATA is unavailable." }
if (-not $RepoRoot) { $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path }
$RepoRoot = (Resolve-Path $RepoRoot).Path

$LauncherSource = Join-Path $RepoRoot "scripts\chrome-native-host-launcher.cs"
$NativeHostJs = Join-Path $RepoRoot "dist\web\chrome-native-host.js"
$ExtensionPath = Join-Path $RepoRoot "assets\chrome-bridge-extension"

if (-not (Test-Path $LauncherSource)) { throw "Chrome bridge launcher source is missing: $LauncherSource" }
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

$NodePath = (Get-Command node.exe -ErrorAction Stop).Source
$LauncherExe = Join-Path $BridgeDir "rwmcp-chrome-native-host.exe"
$RuntimeConfig = Join-Path $BridgeDir "host-runtime.txt"

$cscCandidates = @(
  "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
  "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe"
)
$Csc = $cscCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $Csc) { throw "C# compiler csc.exe was not found." }

& $Csc /nologo /target:exe /optimize+ /out:$LauncherExe $LauncherSource
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $LauncherExe)) {
  throw "Failed to compile Chrome Native Messaging launcher."
}

@($NodePath, $NativeHostJs) | Set-Content -LiteralPath $RuntimeConfig -Encoding UTF8

$ManifestPath = Join-Path $BridgeDir "$HostName.json"
$manifest = [ordered]@{
  name = $HostName
  description = "RWMCP Existing Chrome Bridge native host"
  path = $LauncherExe
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
Write-Output "LauncherExe=$LauncherExe"
Write-Output "TokenPath=$TokenPath"
