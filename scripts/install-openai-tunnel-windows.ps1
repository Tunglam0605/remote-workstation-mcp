$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Version = 'v0.0.14'
$ExpectedSha256 = '784ab8da7b5a88f0109f1fd8aaf0a1c86067430b896dddf307ef7e3cc49fa1a5'
$AssetName = "tunnel-client-$Version-windows-amd64.zip"
$Url = "https://github.com/openai/tunnel-client/releases/download/$Version/$AssetName"
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$TargetDir = Join-Path $Root 'runtime\openai-tunnel'
$Binary = Join-Path $TargetDir 'tunnel-client.exe'

New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null

if (Test-Path $Binary) {
  try {
    $installed = (& $Binary --version 2>&1 | Out-String).Trim()
    if ($installed -match '0\.0\.14') {
      Write-Host "OpenAI tunnel-client $Version is already installed: $Binary" -ForegroundColor Green
      exit 0
    }
  } catch {
    Write-Host 'Existing tunnel-client could not be validated; reinstalling.' -ForegroundColor Yellow
  }
}

$TempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("rwmcp-tunnel-" + [Guid]::NewGuid().ToString('N'))
$ZipPath = Join-Path $TempDir $AssetName
$ExtractDir = Join-Path $TempDir 'extract'
New-Item -ItemType Directory -Force -Path $TempDir, $ExtractDir | Out-Null

try {
  Write-Host "Downloading official OpenAI tunnel-client $Version..."
  Invoke-WebRequest -Uri $Url -OutFile $ZipPath -UseBasicParsing

  $actual = (Get-FileHash -Path $ZipPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $ExpectedSha256) {
    throw "SHA-256 mismatch for $AssetName. Expected $ExpectedSha256 but got $actual."
  }
  Write-Host 'SHA-256 verified.' -ForegroundColor Green

  Expand-Archive -Path $ZipPath -DestinationPath $ExtractDir -Force
  $client = Get-ChildItem -Path $ExtractDir -Filter 'tunnel-client.exe' -File -Recurse | Select-Object -First 1
  if (-not $client) { throw 'The verified archive does not contain tunnel-client.exe.' }

  $sourceDir = $client.Directory.FullName
  Get-ChildItem -Path $sourceDir -Force | ForEach-Object {
    Copy-Item -Path $_.FullName -Destination $TargetDir -Recurse -Force
  }

  if (-not (Test-Path $Binary)) { throw "Installation did not produce $Binary." }
  $versionOutput = (& $Binary --version 2>&1 | Out-String).Trim()
  if ($versionOutput -notmatch '0\.0\.14') {
    throw "Installed tunnel-client version is unexpected: $versionOutput"
  }

  Write-Host ''
  Write-Host "Installed official OpenAI tunnel-client $Version." -ForegroundColor Green
  Write-Host "Binary: $Binary"
  Write-Host 'No OpenAI API key or workstation bearer token was written to disk.'
} finally {
  Remove-Item -Path $TempDir -Recurse -Force -ErrorAction SilentlyContinue
}
