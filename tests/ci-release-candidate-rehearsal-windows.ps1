param(
  [string]$BaselineVersion = '0.71.0',
  [string]$CandidateVersion = '0.71.1'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($env:CI -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or -not $env:RUNNER_TEMP) {
  throw 'Rehearsal requires an isolated GitHub Actions Windows runner.'
}
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$installer = Join-Path $repoRoot 'scripts\install-windows-release.ps1'
$manifest = Get-Content -LiteralPath (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json
if ([string]$manifest.version -ne $CandidateVersion) { throw 'Unexpected candidate version.' }
$runnerRoot = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\')
$testRoot = Join-Path $runnerRoot ('rwmcp-rc-rollback-' + [Guid]::NewGuid().ToString('N'))
$isolatedLocalAppData = Join-Path $testRoot 'AppData\Local'
$installBase = Join-Path $isolatedLocalAppData 'RemoteWorkstationMCP'
$versionsRoot = Join-Path $installBase 'versions'
$currentPointer = Join-Path $installBase 'current.txt'
$previousPointer = Join-Path $installBase 'previous.txt'
$originalLocalAppData = $env:LOCALAPPDATA
$originalNpmCache = $env:npm_config_cache

function Assert-Equals([string]$Actual, [string]$Expected, [string]$Description) {
  if (-not [string]::Equals($Actual.Trim(), $Expected.Trim(), [StringComparison]::OrdinalIgnoreCase)) {
    throw "Assertion failed ($Description): expected '$Expected', got '$Actual'."
  }
}
function Assert-ReleaseDigest([string]$Archive, [string]$ChecksumFile, [string]$AssetName) {
  $line = Get-Content -LiteralPath $ChecksumFile | Where-Object { $_ -match [regex]::Escape($AssetName) } | Select-Object -First 1
  if (-not $line -or $line -notmatch '^\s*([0-9a-fA-F]{64})\s+\*?(.+?)\s*$') {
    throw "Missing published SHA256 for $AssetName."
  }
  if ([IO.Path]::GetFileName($Matches[2].Trim()) -ne $AssetName) { throw 'Checksum filename mismatch.' }
  Assert-Equals (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash $Matches[1] 'published asset digest'
}
function Stage-DisposableReleaseSlot([string]$Archive, [string]$Version) {
  $slot = Join-Path $versionsRoot "v$Version"
  $extract = Join-Path $testRoot ('extract-' + $Version.Replace('.', '-'))
  if (Test-Path -LiteralPath $slot) { throw "Disposable slot already exists: $slot" }
  New-Item -ItemType Directory -Path $extract -Force | Out-Null
  & tar.exe -xzf $Archive -C $extract
  if ($LASTEXITCODE -ne 0) { throw "Cannot extract archive for v$Version." }
  $packageDir = Join-Path $extract 'package'
  $packageManifestPath = Join-Path $packageDir 'package.json'
  if (-not (Test-Path -LiteralPath $packageManifestPath -PathType Leaf)) {
    throw "v$Version archive does not contain npm package/package.json."
  }
  $packedManifest = Get-Content -LiteralPath $packageManifestPath -Raw | ConvertFrom-Json
  if ([string]$packedManifest.version -ne $Version) {
    throw "v$Version package manifest version does not match the archive."
  }
  Move-Item -LiteralPath $packageDir -Destination $slot
  Push-Location $slot
  try {
    & npm.cmd install --omit=dev --no-audit --no-fund --ignore-scripts | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Production dependency install failed for v$Version." }
    $versionOutput = (& node (Join-Path $slot 'dist\cli.js') --version 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $versionOutput -notmatch [regex]::Escape($Version)) {
      throw "v$Version runtime entrypoint failed version smoke: $versionOutput"
    }
  } finally {
    Pop-Location
  }
  Write-Host "Staged and smoke-checked disposable v$Version runtime slot."
  return $slot
}
function Assert-RuntimeExecutable([string]$Slot, [string]$Version, [string]$Phase) {
  $entrypoint = Join-Path $Slot 'dist\cli.js'
  if (-not (Test-Path -LiteralPath $entrypoint -PathType Leaf)) {
    throw "Runtime executable missing after $Phase for v$Version."
  }
  $reported = (& node $entrypoint --version 2>&1 | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $reported -notmatch [regex]::Escape($Version)) {
    throw "Runtime v$Version failed executable smoke after $($Phase): $reported."
  }
  Write-Host "Verified executable v$Version after $Phase."
}
function Invoke-ProductionRollback {
  $out = Join-Path $testRoot ('rollback-out-' + [Guid]::NewGuid().ToString('N') + '.txt')
  $err = Join-Path $testRoot ('rollback-err-' + [Guid]::NewGuid().ToString('N') + '.txt')
  $exe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $argList = @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',('"' + $installer + '"'),'-Rollback')
  $proc = Start-Process -FilePath $exe -ArgumentList $argList -NoNewWindow -Wait -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
  return @{ Code=$proc.ExitCode; Out=(Get-Content -LiteralPath $out -Raw -ErrorAction SilentlyContinue); Err=(Get-Content -LiteralPath $err -Raw -ErrorAction SilentlyContinue) }
}
New-Item -ItemType Directory -Path $versionsRoot -Force | Out-Null
try {
  $headers = @{ Accept='application/vnd.github+json'; 'User-Agent'='RWMCP-Windows-CI-rehearsal' }
  if ($env:GH_TOKEN) { $headers.Authorization = "Bearer $env:GH_TOKEN" }
  $tag = "v$BaselineVersion"
  $url = "https://api.github.com/repos/Tunglam0605/remote-workstation-mcp/releases/tags/$tag"
  $release = Invoke-RestMethod -Uri $url -Headers $headers -TimeoutSec 60
  if ([string]$release.tag_name -ne $tag -or $release.draft -or $release.prerelease) { throw 'Expected published stable baseline.' }
  $assetName = "remote-workstation-mcp-$tag.tgz"
  $tarAsset = @($release.assets | Where-Object { $_.name -eq $assetName })
  $shaAsset = @($release.assets | Where-Object { $_.name -eq 'SHA256SUMS.txt' })
  if ($tarAsset.Count -ne 1 -or $shaAsset.Count -ne 1) { throw 'Published baseline assets missing.' }
  $stableArchive = Join-Path $testRoot $assetName
  $shaFile = Join-Path $testRoot 'SHA256SUMS.txt'
  Invoke-WebRequest -Uri $tarAsset[0].browser_download_url -OutFile $stableArchive -UseBasicParsing -TimeoutSec 240
  Invoke-WebRequest -Uri $shaAsset[0].browser_download_url -OutFile $shaFile -UseBasicParsing -TimeoutSec 60
  Assert-ReleaseDigest $stableArchive $shaFile $assetName
  Push-Location $repoRoot
  try {
    $packed = @(& npm.cmd pack --pack-destination $testRoot --silent)
    if ($LASTEXITCODE -ne 0) { throw 'Candidate npm pack failed.' }
  } finally { Pop-Location }
  $candidateArchive = Join-Path $testRoot "remote-workstation-mcp-$CandidateVersion.tgz"
  if (-not (Test-Path -LiteralPath $candidateArchive)) { throw "Missing local candidate pack: $($packed -join ', ')" }
  $env:LOCALAPPDATA = $isolatedLocalAppData
  $env:npm_config_cache = Join-Path $testRoot 'npm-cache'
  $stableSlot = Stage-DisposableReleaseSlot $stableArchive $BaselineVersion
  $candidateSlot = Stage-DisposableReleaseSlot $candidateArchive $CandidateVersion
  if (-not $stableSlot.StartsWith($versionsRoot + '\', [StringComparison]::OrdinalIgnoreCase) -or -not $candidateSlot.StartsWith($versionsRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Slot escaped disposable versions root.'
  }
  Set-Content -LiteralPath $currentPointer -Value $stableSlot -Encoding UTF8
  $negative = Invoke-ProductionRollback
  if ($negative.Code -eq 0) { throw 'Rollback succeeded without previous slot.' }
  Assert-Equals (Get-Content -LiteralPath $currentPointer -Raw) $stableSlot 'negative rollback pointer'
  if (Test-Path -LiteralPath $previousPointer) { throw 'Negative rollback created previous pointer.' }
  Set-Content -LiteralPath $previousPointer -Value $stableSlot -Encoding UTF8
  Set-Content -LiteralPath $currentPointer -Value $candidateSlot -Encoding UTF8
  $first = Invoke-ProductionRollback
  if ($first.Code -ne 0) { throw "Candidate rollback failed: $($first.Err) $($first.Out)" }
  Assert-Equals (Get-Content -LiteralPath $currentPointer -Raw) $stableSlot 'candidate to stable'
  Assert-Equals (Get-Content -LiteralPath $previousPointer -Raw) $candidateSlot 'preserve candidate'
  Assert-RuntimeExecutable $stableSlot $BaselineVersion 'production rollback'
  if (-not (Test-Path -LiteralPath (Join-Path $installBase 'bin\rwmcp.ps1'))) { throw 'Stable launcher missing.' }
  $second = Invoke-ProductionRollback
  if ($second.Code -ne 0) { throw "Reverse rollback failed: $($second.Err) $($second.Out)" }
  Assert-Equals (Get-Content -LiteralPath $currentPointer -Raw) $candidateSlot 'restore candidate'
  Assert-Equals (Get-Content -LiteralPath $previousPointer -Raw) $stableSlot 'preserve stable'
  Assert-RuntimeExecutable $candidateSlot $CandidateVersion 'reverse rollback'
  Write-Host "PASS: published $tag integrity, local candidate pack, missing-previous rejection, real rollback, reverse rollback."
} finally {
  $env:LOCALAPPDATA = $originalLocalAppData
  $env:npm_config_cache = $originalNpmCache
  $fullRoot = [IO.Path]::GetFullPath($testRoot)
  if ($fullRoot.StartsWith($runnerRoot + '\', [StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($fullRoot).StartsWith('rwmcp-rc-rollback-', [StringComparison]::Ordinal)) {
    Remove-Item -LiteralPath $fullRoot -Recurse -Force
  } else { throw "Refusing unsafe cleanup: $fullRoot" }
}
