param(
  [Parameter(Mandatory = $true)]
  [string]$Root,
  [ValidateSet('Local','OpenAI')]
  [string]$Mode = 'OpenAI',
  [ValidateRange(100,5000)]
  [int]$DelayMs = 750
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Start-Sleep -Milliseconds $DelayMs
$Root = (Resolve-Path $Root).Path
$runtimeScript = Join-Path $Root 'scripts\runtime-control-windows.ps1'
& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $runtimeScript -Action Restart -Mode $Mode -Root $Root
exit $LASTEXITCODE
