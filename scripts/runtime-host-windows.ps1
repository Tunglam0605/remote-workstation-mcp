param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Local','OpenAI')]
  [string]$Mode,
  [Parameter(Mandatory = $true)]
  [string]$Root,
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
$entrypoint = if ($Mode -eq 'OpenAI') {
  Join-Path $Root 'dist\openai-tunnel-cli.js'
} else {
  Join-Path $Root 'dist\cli.js'
}
if (-not (Test-Path $entrypoint)) { throw "Runtime entrypoint not found: $entrypoint" }

# This process intentionally remains alive for the lifetime of the runtime child.
# The control process starts this host with Start-Process and NO stdout/stderr
# redirection so a caller that captures control-command output does not inherit a
# long-lived pipe handle. Runtime output is redirected here, inside the detached
# host process, instead.
try {
  if ($Mode -eq 'Local') {
    & $node.Source $entrypoint '--http' 1>> $StdoutLog 2>> $StderrLog
  } else {
    & $node.Source $entrypoint 1>> $StdoutLog 2>> $StderrLog
  }
  exit $LASTEXITCODE
} catch {
  "[$([DateTimeOffset]::UtcNow.ToString('o'))] runtime host failure: $($_.Exception.Message)" | Add-Content -Path $StderrLog -Encoding utf8
  exit 1
}
