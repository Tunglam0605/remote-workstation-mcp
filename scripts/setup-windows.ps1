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
  maxInputBytes: 65536

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
Write-Host 'Windows runtime bootstrap complete.' -ForegroundColor Green
Write-Host "Default workspace: $Workspace"
Write-Host ''
Write-Host 'Recommended next step: open the local Setup Console.'
Write-Host '  npm run setup:web:windows' -ForegroundColor Cyan
Write-Host ''
Write-Host 'The Setup Console can select a free MCP port, persist the tunnel/org settings, install tunnel-client, and store the runtime API key with Windows DPAPI.'
Write-Host 'For headless/local-only use you can still run:'
Write-Host '  npm run start:windows' -ForegroundColor Cyan
