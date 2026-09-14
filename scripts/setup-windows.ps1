$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $Root

function Require-Command([string]$Name) {
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if (-not $command) { throw "Required command '$Name' was not found in PATH." }
  return $command
}

$node = Require-Command 'node'
Require-Command 'npm' | Out-Null
Require-Command 'git' | Out-Null

$nodeVersionText = (& $node.Source --version).TrimStart('v')
$nodeMajor = [int]($nodeVersionText.Split('.')[0])
if ($nodeMajor -lt 22) {
  throw "Node.js 22+ is required. Found v$nodeVersionText."
}

$Workspace = Join-Path $HOME 'Documents\RemoteWorkspaces'
$ConfigDir = Join-Path $Root 'config'
$RuntimeDir = Join-Path $Root 'runtime'
$PolicyPath = Join-Path $ConfigDir 'policy.yaml'
$HostsPath = Join-Path $ConfigDir 'hosts.yaml'

New-Item -ItemType Directory -Force -Path $Workspace, $ConfigDir, $RuntimeDir | Out-Null

if (-not (Test-Path $PolicyPath)) {
  $workspaceYaml = $Workspace.Replace('\', '/')
  @"
version: 1
mode: workspace

workspaces:
  - id: projects
    name: Projects
    root: "$workspaceYaml"
    readOnly: false

filesystem:
  maxReadBytes: 1048576
  maxWriteBytes: 1048576

search:
  maxResults: 100
  maxFiles: 5000
  maxFileBytes: 1048576

process:
  allowExecutables:
    - git
    - node
    - python
    - py
    - cmake
    - ninja
  inheritEnv:
    - PATH
    - USERPROFILE
    - HOME
    - LANG
    - TEMP
    - TMP
  maxOutputBytes: 262144
  maxRuntimeMs: 600000

tasks: {}

fullControl:
  allowRawShell: false
  allowHostFilesystem: false

privileged:
  allowSudo: false
  maxRuntimeMs: 600000
"@ | Set-Content -Path $PolicyPath -Encoding utf8
  Write-Host "Created Windows policy: $PolicyPath"
} else {
  Write-Host "Keeping existing policy: $PolicyPath"
}

if (-not (Test-Path $HostsPath)) {
  @"
version: 1
hosts: []
"@ | Set-Content -Path $HostsPath -Encoding utf8
  Write-Host "Created SSH hosts config: $HostsPath"
} else {
  Write-Host "Keeping existing SSH hosts config: $HostsPath"
}

Write-Host 'Installing dependencies...'
npm install --no-audit --no-fund
Write-Host 'Running typecheck...'
npm run typecheck
Write-Host 'Running tests...'
npm test
Write-Host 'Building runtime...'
npm run build
Write-Host 'Validating plugin package...'
npm run plugin:validate

Write-Host ''
Write-Host 'Windows setup complete.' -ForegroundColor Green
Write-Host "Workspace: $Workspace"
Write-Host 'Start the MCP service in the foreground with:'
Write-Host '  npm run start:windows' -ForegroundColor Cyan
Write-Host 'Then verify from a second PowerShell window:'
Write-Host '  Invoke-RestMethod http://127.0.0.1:8765/healthz' -ForegroundColor Cyan
