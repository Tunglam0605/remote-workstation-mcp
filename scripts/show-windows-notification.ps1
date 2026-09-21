param(
  [Parameter(Mandatory = $true)]
  [string]$PayloadBase64,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

function Decode-Payload([string]$Encoded) {
  try {
    $bytes = [Convert]::FromBase64String($Encoded)
    $json = [Text.Encoding]::UTF8.GetString($bytes)
    return $json | ConvertFrom-Json
  } catch {
    throw 'Invalid desktop notification payload.'
  }
}

$payload = Decode-Payload $PayloadBase64
$app = ([string]$payload.app).Trim()
$title = ([string]$payload.title).Trim()
$body = ([string]$payload.body).Trim()
$kind = ([string]$payload.kind).Trim().ToLowerInvariant()

if ([string]::IsNullOrWhiteSpace($app)) { $app = 'Remote Workstation MCP' }
if ([string]::IsNullOrWhiteSpace($title)) { throw 'Notification title is required.' }
if ([string]::IsNullOrWhiteSpace($body)) { throw 'Notification body is required.' }

if ($app.Length -gt 63) { $app = $app.Substring(0, 63) }
if ($title.Length -gt 96) { $title = $title.Substring(0, 96) }
if ($body.Length -gt 320) { $body = $body.Substring(0, 320) }

$iconName = switch ($kind) {
  'error' { 'Error' }
  'warning' { 'Warning' }
  'approval' { 'Warning' }
  default { 'Info' }
}

if ($DryRun) {
  [pscustomobject]@{
    ok = $true
    app = $app
    title = $title
    body = $body
    kind = $kind
    icon = $iconName
  } | ConvertTo-Json -Compress
  exit 0
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$notify = New-Object System.Windows.Forms.NotifyIcon
try {
  $notify.Visible = $true
  $notify.Text = $app
  $notify.Icon = switch ($iconName) {
    'Error' { [System.Drawing.SystemIcons]::Error }
    'Warning' { [System.Drawing.SystemIcons]::Warning }
    default { [System.Drawing.SystemIcons]::Information }
  }
  $notify.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::$iconName
  $notify.BalloonTipTitle = $title
  $notify.BalloonTipText = $body
  $notify.ShowBalloonTip(7000)
  Start-Sleep -Milliseconds 7500
} finally {
  $notify.Visible = $false
  $notify.Dispose()
}
