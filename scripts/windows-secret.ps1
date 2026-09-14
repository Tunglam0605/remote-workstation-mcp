param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Set', 'Get', 'Delete', 'Exists')]
  [string]$Action,

  [Parameter(Mandatory = $true)]
  [string]$Path
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Ensure-Parent([string]$FilePath) {
  $parent = Split-Path -Parent $FilePath
  if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
}

switch ($Action) {
  'Set' {
    Ensure-Parent $Path
    $plain = [Console]::In.ReadToEnd()
    if ([string]::IsNullOrWhiteSpace($plain)) { throw 'Secret input is empty.' }
    $secure = ConvertTo-SecureString $plain -AsPlainText -Force
    $protected = ConvertFrom-SecureString $secure
    Set-Content -Path $Path -Value $protected -Encoding ascii -NoNewline
    exit 0
  }
  'Get' {
    if (-not (Test-Path $Path)) { exit 2 }
    $protected = Get-Content -Path $Path -Raw
    $secure = ConvertTo-SecureString $protected
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
      [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr))
    }
    finally {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
    }
    exit 0
  }
  'Delete' {
    Remove-Item -Path $Path -Force -ErrorAction SilentlyContinue
    exit 0
  }
  'Exists' {
    if (Test-Path $Path) { exit 0 }
    exit 1
  }
}
