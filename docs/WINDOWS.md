# Windows runtime

Remote Workstation MCP v0.7.5 supports two Windows workflows:

1. **managed release installation** for normal/new-machine use;
2. **repository development** for contributors.

Both keep the MCP endpoint loopback-only and can use the outbound OpenAI Secure MCP Tunnel path.

## Requirements

- Windows 10/11
- PowerShell 5.1+ or PowerShell 7+
- Node.js 22+
- npm
- Git
- OpenSSH client when SSH tools are needed

The managed installer can use `winget` to install Node.js LTS and Git when they are missing.

## Recommended managed installation

```powershell
$installer = Join-Path $env:TEMP 'rwmcp-install.ps1'
Invoke-WebRequest `
  'https://github.com/Tunglam0605/remote-workstation-mcp/releases/latest/download/install-windows.ps1' `
  -OutFile $installer
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File $installer
```

The installer downloads the release package and `SHA256SUMS.txt`, verifies the package digest, installs a versioned runtime slot, installs the pinned OpenAI tunnel-client, writes a stable launcher and opens the local Setup & Control Center.

No Git checkout is required for the managed runtime itself.

Managed state lives under:

```text
%LOCALAPPDATA%\RemoteWorkstationMCP\
```

Application versions are isolated under `versions\vX.Y.Z\`; owner configuration and secrets remain outside those slots.

## Repository-development setup

```powershell
cd "$HOME\Documents"
git clone https://github.com/Tunglam0605/remote-workstation-mcp.git
cd remote-workstation-mcp
git checkout v0.7.5
npm run setup:first-run:windows
```

This installs development dependencies, runs typecheck/tests/build/plugin validation and opens the same loopback-only web UI.

## Setup & Control Center

The UI configures the MCP port, workspace root, OpenAI tunnel ID, organization ID, Cloudflare-managed preference and Windows DPAPI runtime-key persistence.

It also provides owner-local runtime controls:

- start local MCP;
- start ChatGPT/OpenAI tunnel mode;
- stop/restart;
- view MCP health/version/auth;
- view tunnel readiness;
- enable/disable current-user start-at-logon.

The UI is not an MCP tool and is never exposed through the tunnel. Full-control gates and permission leases are deliberately excluded.

See [Setup & Control Center](SETUP_CONSOLE.md).

## Stable launcher

Managed installs create:

```text
%LOCALAPPDATA%\RemoteWorkstationMCP\bin\rwmcp.ps1
```

Example:

```powershell
$ctl = "$env:LOCALAPPDATA\RemoteWorkstationMCP\bin\rwmcp.ps1"
& $ctl -Action Setup
& $ctl -Action StartOpenAI
& $ctl -Action Status
& $ctl -Action Stop
```

The launcher resolves `current.txt`, so start-at-logon and operator commands continue to follow the active version after an update.

## Update and rollback

```powershell
& "$env:LOCALAPPDATA\RemoteWorkstationMCP\bin\rwmcp.ps1" -Action Update
```

The installer adds a new verified version slot and moves `current.txt`. If a previous valid slot exists it is recorded in `previous.txt`.

Rollback:

```powershell
& "$env:LOCALAPPDATA\RemoteWorkstationMCP\bin\rwmcp.ps1" -Action Rollback
```

This switches the stable pointer back to the previous slot; it does not rewrite policy, hosts, settings, audit data or DPAPI secrets.

## Start at logon

The Control Center registers a current-user `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` entry that invokes the stable launcher after user logon. This path requires no Administrator rights and avoids Windows environments that reject `Register-ScheduledTask` for standard users.

The runtime still runs with the same permissions as the logged-in Windows account. Start-at-logon does not grant Administrator privileges. Upgrades from older releases also recognize and best-effort remove the previous Scheduled Task registration to avoid duplicate starts.

## Configuration storage

Non-secret setup state:

```text
%LOCALAPPDATA%\RemoteWorkstationMCP\settings.json
```

Stable owner config for managed installs:

```text
%LOCALAPPDATA%\RemoteWorkstationMCP\config\policy.yaml
%LOCALAPPDATA%\RemoteWorkstationMCP\config\hosts.yaml
```

DPAPI-protected runtime key:

```text
%LOCALAPPDATA%\RemoteWorkstationMCP\secrets\openai-runtime-api-key.dpapi
```

Runtime supervisor state/logs:

```text
%LOCALAPPDATA%\RemoteWorkstationMCP\runtime\
```

Explicit environment variables remain authoritative over persisted setup values.

## Local-only runtime

Repository development:

```powershell
npm run start:windows
```

Managed installation:

```powershell
& "$env:LOCALAPPDATA\RemoteWorkstationMCP\bin\rwmcp.ps1" -Action Start
```

Health example:

```powershell
Invoke-RestMethod http://127.0.0.1:8683/healthz
```

Expected fields include:

```text
ok        : True
version   : 0.7.5
mode      : workspace
transport : http-loopback
```

## ChatGPT/OpenAI tunnel runtime

Repository development:

```powershell
npm run start:openai:windows
```

Managed installation:

```powershell
& "$env:LOCALAPPDATA\RemoteWorkstationMCP\bin\rwmcp.ps1" -Action StartOpenAI
```

The tunnel path forces bearer authentication on the MCP leg. The local bearer is generated per run unless the owner supplies one. The OpenAI runtime API key is not forwarded into the MCP child process.

Managed Cloudflare runtime material is optional and remains disabled unless explicitly selected.

See [ChatGPT Web](CHATGPT_WEB.md) and [OpenAI Secure MCP Tunnel](OPENAI_SECURE_TUNNEL.md).

## Windows security notes

- Setup/control UI binds only to loopback.
- API calls require an ephemeral setup token and same-origin browser access.
- Managed stop validates the stored supervisor process before terminating its descendant tree.
- Background state stores PIDs and operational metadata, not the OpenAI runtime API key.
- Start-at-logon uses the current-user registry hive and does not elevate privileges.
- Raw shell and host filesystem capabilities remain disabled by default.
- Root/Administrator execution is not exposed by the normal MCP runtime.
- Windows `.cmd`/`.bat` wrappers are not treated as equivalent to native executable execution in the normal process allowlist.

Managed process stdin remains pipe-backed; a true PTY/ConPTY adapter is a v0.8 roadmap item.

## Semantic code intelligence

Owner-configured language servers support definition, references, hover, document symbols and diagnostics. They remain executable-allowlisted and workspace-bounded. See [LSP](LSP.md).
