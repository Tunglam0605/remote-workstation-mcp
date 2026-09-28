param(
  [Parameter(Mandatory = $true)][string]$IdfPath,
  [Parameter(Mandatory = $true)][string]$ArgsJson,
  [string]$PythonEnvPath = '',
  [ValidateSet('', '0', '1')][string]$SkipCheckSubmodules = '',
  [switch]$Provenance
)
$ErrorActionPreference = 'Stop'

$exportScript = Join-Path $IdfPath 'export.ps1'
$idfScript = Join-Path $IdfPath 'tools\idf.py'
if (-not (Test-Path -LiteralPath $exportScript -PathType Leaf)) { throw "ESP-IDF export.ps1 not found: $exportScript" }
if (-not (Test-Path -LiteralPath $idfScript -PathType Leaf)) { throw "ESP-IDF idf.py not found: $idfScript" }

if ($PythonEnvPath) {
  $pythonCandidate = Join-Path $PythonEnvPath 'Scripts\python.exe'
  if (-not (Test-Path -LiteralPath $pythonCandidate -PathType Leaf)) {
    throw "Invalid ESP-IDF Python environment: $PythonEnvPath"
  }
  $env:IDF_PYTHON_ENV_PATH = $PythonEnvPath
}

if ($SkipCheckSubmodules -eq '1') {
  $env:IDF_SKIP_CHECK_SUBMODULES = '1'
} elseif ($SkipCheckSubmodules -eq '0') {
  Remove-Item Env:IDF_SKIP_CHECK_SUBMODULES -ErrorAction SilentlyContinue
}

. $exportScript | Out-Null
$python = Get-Command python -ErrorAction Stop

if ($Provenance) {
  & $python.Source -c "import json, os, platform, sys; print(json.dumps({'pythonExecutable': sys.executable, 'pythonVersion': platform.python_version(), 'pythonEnvPath': os.environ.get('IDF_PYTHON_ENV_PATH'), 'idfPath': os.environ.get('IDF_PATH'), 'idfToolsPath': os.environ.get('IDF_TOOLS_PATH'), 'skipCheckSubmodules': os.environ.get('IDF_SKIP_CHECK_SUBMODULES') == '1'}, separators=(',', ':')))"
  exit $LASTEXITCODE
}

$argsList = @($ArgsJson | ConvertFrom-Json)
& $python.Source $idfScript @argsList
exit $LASTEXITCODE
