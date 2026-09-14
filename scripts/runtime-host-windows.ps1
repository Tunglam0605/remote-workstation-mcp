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
# The parent control command starts this host with no redirected stdio, so callers
# that capture the control command receive EOF promptly. This host owns the log
# redirection and waits for the real Node runtime. Using Start-Process here also
# avoids PowerShell converting normal native stderr diagnostics into terminating
# ErrorRecord objects when ErrorActionPreference is Stop.
try {
  $args = @("`"$entrypoint`"")
  if ($Mode -eq 'Local') { $args += '--http' }
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
  "[$([DateTimeOffset]::UtcNow.ToString('o'))] runtime host failure: $($_.Exception.Message)" | Add-Content -Path $StderrLog -Encoding utf8
  exit 1
}
