param(
  [Parameter(Mandatory = $true)]
  [string]$Root,
  [Parameter(Mandatory = $true)]
  [int]$Port,
  [Parameter(Mandatory = $true)]
  [string]$StdoutLog,
  [Parameter(Mandatory = $true)]
  [string]$StderrLog
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$Root = (Resolve-Path $Root).Path
Set-Location $Root
$node = Get-Command node -ErrorAction Stop
$entrypoint = Join-Path $Root 'dist\setup-web-cli.js'
if (-not (Test-Path $entrypoint)) { throw "Control Center entrypoint not found: $entrypoint" }

try {
  $args = @(
    "`"$entrypoint`"",
    '--no-open',
    '--persistent',
    '--strict-port',
    '--port',
    [string]$Port
  )
  $child = Start-Process `
    -FilePath $node.Source `
    -ArgumentList ($args -join ' ') `
    -WorkingDirectory $Root `
    -WindowStyle Hidden `
    -RedirectStandardOutput $StdoutLog `
    -RedirectStandardError $StderrLog `
    -PassThru `
    -Wait
  exit $child.ExitCode
} catch {
  "[$([DateTimeOffset]::UtcNow.ToString('o'))] control-center host failure: $($_.Exception.Message)" | Add-Content -Path $StderrLog -Encoding utf8
  exit 1
}
