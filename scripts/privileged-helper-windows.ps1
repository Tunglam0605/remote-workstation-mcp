param(
  [Parameter(Mandatory=$true)][string]$RequestPath,
  [Parameter(Mandatory=$true)][string]$ExpectedSha256
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$MaxOutputChars = 262144

function Write-JsonNoBom($Value) {
  $json = $Value | ConvertTo-Json -Depth 10
  [IO.File]::WriteAllText($RequestPath, $json + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
}

function Is-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

$request = $null
try {
  if (-not (Is-Administrator)) { throw 'Privileged helper is not running as Administrator.' }
  if (-not (Test-Path $RequestPath)) { throw "Admin request file not found: $RequestPath" }
  $actualHash = (Get-FileHash -Path $RequestPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualHash -ne $ExpectedSha256.ToLowerInvariant()) {
    throw 'Admin request changed after owner approval; refusing execution.'
  }

  $request = Get-Content -Path $RequestPath -Raw | ConvertFrom-Json
  if ([string]$request.state -ne 'approved') { throw "Admin request state is '$($request.state)', expected 'approved'." }
  $expires = [DateTimeOffset]::Parse([string]$request.expiresAt)
  if ($expires -le [DateTimeOffset]::UtcNow) { throw 'Admin request expired before execution.' }

  $blocked = @('cmd.exe','powershell.exe','pwsh.exe','wscript.exe','cscript.exe','mshta.exe','rundll32.exe')
  $requestedProgram = [string]$request.program
  if ($requestedProgram.IndexOf([char]0) -ge 0 -or $requestedProgram -match "[`r`n]") { throw 'Program contains invalid control characters.' }

  if ([IO.Path]::IsPathRooted($requestedProgram)) {
    $program = [IO.Path]::GetFullPath($requestedProgram)
    if (-not (Test-Path -LiteralPath $program -PathType Leaf)) { throw "Program not found: $program" }
  } else {
    $command = Get-Command $requestedProgram -CommandType Application -ErrorAction Stop | Select-Object -First 1
    $program = $command.Source
  }

  $leaf = [IO.Path]::GetFileName($program).ToLowerInvariant()
  if ($blocked -contains $leaf) { throw "Direct privileged shell host '$leaf' is blocked. Request the target executable directly." }
  $extension = [IO.Path]::GetExtension($program).ToLowerInvariant()
  if ($extension -notin @('.exe','.com')) { throw "Privileged helper accepts direct .exe/.com applications only, not '$extension'." }

  $request.state = 'running'
  $request | Add-Member -NotePropertyName startedAt -NotePropertyValue ([DateTimeOffset]::UtcNow.ToString('o')) -Force
  Write-JsonNoBom $request

  $arguments = @($request.args | ForEach-Object { [string]$_ })
  foreach ($argument in $arguments) {
    if ($argument.IndexOf([char]0) -ge 0) { throw 'An argument contains a NUL character.' }
  }
  $cwdValue = if ($request.PSObject.Properties.Name -contains 'cwd') { [string]$request.cwd } else { '' }
  $oldLocation = Get-Location
  try {
    if (-not [string]::IsNullOrWhiteSpace($cwdValue)) {
      $cwd = [IO.Path]::GetFullPath($cwdValue)
      if (-not (Test-Path -LiteralPath $cwd -PathType Container)) { throw "Working directory not found: $cwd" }
      Set-Location -LiteralPath $cwd
    }
    $outputLines = & $program @arguments 2>&1
    $exitCode = if ($null -eq $LASTEXITCODE) { 0 } else { [int]$LASTEXITCODE }
    $output = ($outputLines | Out-String)
  } finally {
    Set-Location $oldLocation
  }

  if ($output.Length -gt $MaxOutputChars) { $output = $output.Substring($output.Length - $MaxOutputChars) }
  $request.state = if ($exitCode -eq 0) { 'succeeded' } else { 'failed' }
  $request | Add-Member -NotePropertyName result -NotePropertyValue ([pscustomobject]@{
    exitCode = $exitCode
    output = $output
    finishedAt = [DateTimeOffset]::UtcNow.ToString('o')
  }) -Force
  Write-JsonNoBom $request
  exit $exitCode
} catch {
  if ($null -ne $request) {
    try {
      $request.state = 'failed'
      $request | Add-Member -NotePropertyName result -NotePropertyValue ([pscustomobject]@{
        exitCode = $null
        output = ''
        finishedAt = [DateTimeOffset]::UtcNow.ToString('o')
        error = $_.Exception.Message
      }) -Force
      Write-JsonNoBom $request
    } catch {}
  }
  exit 1
}
