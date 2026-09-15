param(
  [Parameter(Mandatory=$true)][string]$RequestPath,
  [Parameter(Mandatory=$true)][string]$ExpectedSha256,
  [Parameter(Mandatory=$true)][string]$Root
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Write-RequestFailure([string]$Message) {
  try {
    if (-not (Test-Path $RequestPath)) { return }
    $request = Get-Content -Path $RequestPath -Raw | ConvertFrom-Json
    $request.state = 'failed'
    $request | Add-Member -NotePropertyName result -NotePropertyValue ([pscustomobject]@{
      exitCode = $null
      output = ''
      finishedAt = [DateTimeOffset]::UtcNow.ToString('o')
      error = $Message
    }) -Force
    $json = $request | ConvertTo-Json -Depth 10
    [IO.File]::WriteAllText($RequestPath, $json + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
  } catch {}
}

try {
  # Local owner approval in Control Center is mandatory. Elevation is then
  # requested through Windows RunAs/UAC using the machine's configured UAC policy.
  $helper = Join-Path $Root 'scripts\privileged-helper-windows.ps1'
  if (-not (Test-Path $helper)) { throw "Privileged helper not found: $helper" }
  $powershell = (Get-Command powershell.exe -ErrorAction Stop).Source
  $argLine = @(
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', "`"$helper`"",
    '-RequestPath', "`"$RequestPath`"",
    '-ExpectedSha256', $ExpectedSha256
  ) -join ' '
  $process = Start-Process -FilePath $powershell -Verb RunAs -ArgumentList $argLine -PassThru -Wait
  if ($process.ExitCode -ne 0) {
    throw "Privileged helper exited with code $($process.ExitCode)."
  }
} catch {
  Write-RequestFailure $_.Exception.Message
  exit 1
}
