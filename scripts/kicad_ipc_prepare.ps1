param(
    [Parameter(Mandatory = $true)]
    [ValidateRange(9, 99)]
    [int]$KiCadMajor
)

$ErrorActionPreference = 'Stop'

function Emit-Result([hashtable]$Value) {
    $Value | ConvertTo-Json -Depth 8 -Compress
}

if (-not $env:APPDATA) {
    Emit-Result @{ state = 'error'; error = 'APPDATA is not available.' }
    exit 2
}

$running = @(Get-Process -Name 'kicad','pcbnew' -ErrorAction SilentlyContinue)
if ($running.Count -gt 0) {
    Emit-Result @{
        state = 'blocked'
        reason = 'KICAD_IPC_PREPARE_REQUIRES_KICAD_CLOSED'
        processes = @($running | Select-Object -First 8 | ForEach-Object {
            @{ name = $_.ProcessName; pid = $_.Id }
        })
        changed = $false
    }
    exit 0
}

$versionDir = "$KiCadMajor.0"
$configPath = Join-Path $env:APPDATA "kicad\$versionDir\kicad_common.json"
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    Emit-Result @{ state = 'error'; error = "KiCad common config was not found for version $versionDir." }
    exit 2
}

$item = Get-Item -LiteralPath $configPath
if ($item.Length -gt 2MB) {
    Emit-Result @{ state = 'error'; error = 'KiCad common config exceeds the 2 MiB safety limit.' }
    exit 2
}

$raw = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8
$config = $raw | ConvertFrom-Json
if ($null -eq $config.api) {
    $config | Add-Member -MemberType NoteProperty -Name api -Value ([pscustomobject]@{})
}
if ($config.api.PSObject.Properties.Name -notcontains 'enable_server') {
    $config.api | Add-Member -MemberType NoteProperty -Name enable_server -Value $false
}

$before = [bool]$config.api.enable_server
if ($before) {
    Emit-Result @{
        state = 'ready'
        configPath = $configPath
        enableServer = $true
        changed = $false
        backupPath = $null
        restartRequired = $false
    }
    exit 0
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupPath = "$configPath.rwmcp-ipc-$stamp.bak"
Copy-Item -LiteralPath $configPath -Destination $backupPath -ErrorAction Stop

$config.api.enable_server = $true
$tempPath = "$configPath.rwmcp-ipc-$PID.tmp"
try {
    $json = $config | ConvertTo-Json -Depth 64
    [System.IO.File]::WriteAllText($tempPath, $json, [System.Text.UTF8Encoding]::new($false))
    $verify = Get-Content -LiteralPath $tempPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not [bool]$verify.api.enable_server) {
        throw 'KiCad IPC enable_server verification failed before commit.'
    }
    Move-Item -LiteralPath $tempPath -Destination $configPath -Force
}
catch {
    Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
    throw
}

Emit-Result @{
    state = 'prepared'
    configPath = $configPath
    enableServer = $true
    changed = $true
    backupPath = $backupPath
    restartRequired = $true
}
