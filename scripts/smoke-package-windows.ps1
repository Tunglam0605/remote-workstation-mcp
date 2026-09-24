param(
  [string]$Archive = ''
)
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Temp = Join-Path ([IO.Path]::GetTempPath()) ("rwmcp-pack-smoke-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $Temp | Out-Null
try {
  if ([string]::IsNullOrWhiteSpace($Archive)) {
    Push-Location $Root
    try {
      $name = (& npm pack --pack-destination $Temp --silent | Select-Object -Last 1).Trim()
      if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($name)) { throw 'npm pack failed.' }
      $Archive = Join-Path $Temp $name
    } finally { Pop-Location }
  } elseif (-not [IO.Path]::IsPathRooted($Archive)) {
    $Archive = Join-Path $Root $Archive
  }
  if (-not (Test-Path -LiteralPath $Archive -PathType Leaf)) { throw "Package archive not found: $Archive" }
  $PackageDir = Join-Path $Temp 'package'
  New-Item -ItemType Directory -Force -Path $PackageDir | Out-Null
  & tar.exe -xzf $Archive --strip-components=1 -C $PackageDir
  if ($LASTEXITCODE -ne 0) { throw 'tar extraction failed.' }
  foreach ($required in @(
    'package.json',
    'dist\cli.js',
    'scripts\smoke-engineering-native.mjs',
    'scripts\install-chrome-bridge-windows.ps1',
    'scripts\chrome-native-host-launcher.cs',
    'assets\chrome-bridge-extension\manifest.json',
    'assets\chrome-bridge-extension\service-worker.js',
    'assets\chrome-bridge-extension\content-script.js',
    'assets\moonlight\navigation.js',
    'dist\web\chrome-native-host.js',
    'dist\web\chrome-bridge-protocol.js'
  )) {
    if (-not (Test-Path -LiteralPath (Join-Path $PackageDir $required))) { throw "Packed release is missing $required" }
  }
  Push-Location $PackageDir
  try {
    & npm install --omit=dev --no-audit --no-fund --ignore-scripts
    if ($LASTEXITCODE -ne 0) { throw 'Packed production dependency install failed.' }
    & node scripts/smoke-engineering-native.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Packed engineering native smoke failed.' }
    $expected = (Get-Content package.json -Raw | ConvertFrom-Json).version
    $actual = (& node dist/cli.js --version | Out-String).Trim()
    if ($actual -notmatch [regex]::Escape($expected)) { throw "Packed runtime version mismatch: expected $expected, got $actual" }
    Write-Host "Windows packed release smoke passed for v$expected" -ForegroundColor Green
  } finally { Pop-Location }
} finally {
  Remove-Item -LiteralPath $Temp -Recurse -Force -ErrorAction SilentlyContinue
}
