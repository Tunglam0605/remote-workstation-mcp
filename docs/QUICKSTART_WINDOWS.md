# Windows → ChatGPT quick start

The target user experience for v0.7.3 is deliberately small:

1. install Remote Workstation MCP once on the Windows PC;
2. complete the local Setup & Control Center once;
3. add the custom MCP app in ChatGPT Web and select that PC's OpenAI tunnel;
4. from then on the runtime starts automatically at Windows logon and ChatGPT can reconnect without reopening a terminal.

The workstation MCP remains loopback-only. ChatGPT reaches it through OpenAI Secure MCP Tunnel; no inbound router/firewall port is required.

## New Windows PC

Download `install-windows.ps1` from the latest GitHub Release and run it with PowerShell. The installer:

- installs/checks Node.js and Git through `winget` when needed;
- downloads the release package and `SHA256SUMS.txt`;
- verifies SHA-256 before extraction;
- installs into a per-user version slot under `%LOCALAPPDATA%\RemoteWorkstationMCP`;
- installs the pinned official OpenAI `tunnel-client`;
- creates a stable Start Menu shortcut;
- opens the local Setup & Control Center.

For a terminal-first install:

```powershell
$installer = Join-Path $env:TEMP 'rwmcp-install-windows.ps1'
Invoke-WebRequest `
  'https://github.com/Tunglam0605/remote-workstation-mcp/releases/latest/download/install-windows.ps1' `
  -OutFile $installer `
  -UseBasicParsing
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $installer
```

The release installer itself is published together with `SHA256SUMS.txt`; the installer then verifies the versioned runtime package before installing it.

## Setup & Control Center

For the recommended ChatGPT path, enter only the owner-specific values:

- authorized workspace root;
- OpenAI Tunnel ID;
- OpenAI Organization ID when applicable;
- restricted runtime API key with **Tunnels Read + Use**.

Then press **Prepare this PC for ChatGPT**. The local wizard performs the remaining workstation-side steps:

1. persists non-secret settings outside the runtime version slot;
2. stores the runtime key with Windows current-user DPAPI when requested;
3. installs/verifies `tunnel-client`;
4. starts Remote Workstation MCP behind the Secure MCP Tunnel;
5. verifies MCP/tunnel readiness;
6. enables current-user start-at-logon.

A green **ChatGPT-ready on this PC** state means all workstation-side work is complete.

## ChatGPT Web

Open ChatGPT Apps, create/add the custom MCP app, choose **Connection: Tunnel**, and select or paste the tunnel ID shown by the local Control Center.

The tunnel must be scoped to the target ChatGPT workspace to appear in the workspace's tunnel picker. OpenAI currently documents full custom MCP write/modify support on ChatGPT Web for Business, Enterprise and Edu workspaces; product entitlement is independent of local workstation readiness.

Once the app is added, ordinary use should not require PowerShell or the Setup & Control Center. The local runtime can start automatically at logon.

## Additional PCs

Treat each workstation as its own security boundary and normally give it its own tunnel/runtime key. Repeat the Windows installer on the new PC, press **Prepare this PC for ChatGPT**, then add/select that PC's tunnel in ChatGPT Web.

Do not run multiple independent workstation runtimes against one tunnel ID unless the OpenAI tunnel documentation explicitly supports that deployment mode. Separate device tunnels make revocation, audit and failure isolation clearer.

## What cannot be automated by the local installer

The self-hosted project cannot silently install or approve an app inside a ChatGPT workspace. Developer Mode, custom-app publication/approval and workspace entitlement are controlled by ChatGPT/OpenAI. Automating those product controls would require a different hosted service or an OpenAI-supported management API and is intentionally outside the local workstation security boundary.
