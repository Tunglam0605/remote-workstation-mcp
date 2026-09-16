param(
  [Parameter(Mandatory = $true)][string]$IdfPath,
  [Parameter(Mandatory = $true)][string]$ArgsJson
)
$ErrorActionPreference = 'Stop'
$exportScript = Join-Path $IdfPath 'export.ps1'
$idfScript = Join-Path $IdfPath 'tools\idf.py'
if (-not (Test-Path -LiteralPath $exportScript -PathType Leaf)) { throw "ESP-IDF export.ps1 not found: $exportScript" }
if (-not (Test-Path -LiteralPath $idfScript -PathType Leaf)) { throw "ESP-IDF idf.py not found: $idfScript" }
. $exportScript | Out-Null
$argsList = @($ArgsJson | ConvertFrom-Json)
$python = Get-Command python -ErrorAction Stop
& $python.Source $idfScript @argsList
exit $LASTEXITCODE
