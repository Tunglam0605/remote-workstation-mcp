# Local Setup & Control Center

Remote Workstation MCP provides an owner-operated **Setup & Control Center** for Windows while keeping privileged control APIs outside the MCP tool surface.

The managed layout uses two loopback ports by default: MCP on `127.0.0.1:8683` and the Control Center on `127.0.0.1:8684`. Browser navigation to `http://127.0.0.1:8683/` or `/setup` redirects locally to the dedicated Control Center. The OpenAI tunnel continues to target only the MCP `/mcp` endpoint.

The Control Center rejects non-loopback clients and cross-origin API calls. Each Control Center process generates an ephemeral in-memory CSRF token and embeds it only in the locally served page; the token is not persisted and is not placed in the URL.

## Recommended Windows installation

Production/new-machine installation does not require a Git checkout. Download the release installer, inspect it, then run it:

```powershell
$installer = Join-Path $env:TEMP 'rwmcp-install.ps1'
Invoke-WebRequest `
  'https://github.com/Tunglam0605/remote-workstation-mcp/releases/latest/download/install-windows.ps1' `
  -OutFile $installer
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File $installer
```

The installer:

1. verifies Node.js/npm/Git prerequisites and can use `winget` when they are missing;
2. resolves the selected GitHub Release;
3. downloads the release package and `SHA256SUMS.txt`;
4. verifies the package SHA-256 before extraction;
5. installs into a per-user version slot under `%LOCALAPPDATA%\RemoteWorkstationMCP\versions\`;
6. installs production npm dependencies and validates the runtime version;
7. installs the pinned, checksum-verified OpenAI `tunnel-client`;
8. switches the stable `current.txt` pointer and preserves the previous slot for rollback;
9. creates a stable launcher and Start Menu shortcut;
10. opens the local Setup & Control Center.

For repository development, the existing flow remains supported:

```powershell
npm run setup:first-run:windows
```

## Versioned per-user layout

Managed Windows installs use:

```text
%LOCALAPPDATA%\RemoteWorkstationMCP\
├── current.txt
├── previous.txt
├── settings.json
├── audit.jsonl
├── bin\
│   ├── rwmcp.ps1
│   └── install-windows-release.ps1
├── config\
│   ├── policy.yaml
│   └── hosts.yaml
├── runtime\
│   ├── supervisor.json
│   ├── supervisor.stdout.log
│   ├── supervisor.stderr.log
│   ├── control-center.json
│   ├── control-center.stdout.log
│   ├── control-center.stderr.log
│   ├── permission-lease.json
│   └── admin-approvals\
├── secrets\
│   └── openai-runtime-api-key.dpapi
└── versions\
    ├── v0.7.6\
    └── v0.7.7\
```

Policy/hosts/settings/secrets are therefore not replaced when the application version changes.

## What the Control Center configures

The web flow can configure:

- MCP loopback port (`RWMCP_PORT` equivalent), with automatic free-port recommendation;
- dedicated Control Center loopback port (default `8684`);
- authorized workspace root for a new default policy;
- OpenAI Secure MCP Tunnel ID;
- OpenAI organization ID;
- managed Cloudflare runtime opt-in/out;
- official OpenAI `tunnel-client` installation on Windows;
- OpenAI runtime API key storage using current-user Windows DPAPI;
- one simple daily access mode: **Read only**, **Workspace**, or **Full access**;
- automatic mapping from that mode to authenticated tunnel scopes and local host-filesystem/raw-shell gates;
- `workstation.admin_request`, which can create a pending Administrator request but cannot elevate by itself;
- one-shot Administrator approval through the local Control Center and Windows RunAs/UAC elevation;
- legacy short `full_control` leases remain supported for compatibility and temporary workflows, but are no longer part of the default daily UI.

This explicitly handles machines where another local MCP/plugin already owns port `8765`; the UI can recommend alternatives such as `8683`, `8877`, or another free loopback port.

The runtime API key is never written to `settings.json`. When the owner chooses persistence, the encrypted DPAPI blob is stored at:

```text
%LOCALAPPDATA%\RemoteWorkstationMCP\secrets\openai-runtime-api-key.dpapi
```

The UI never reads the decrypted key back into the browser after saving it.

## Runtime controls

The Control Center provides owner-local controls for:

- start ChatGPT/OpenAI tunnel mode;
- start local MCP-only mode;
- stop the managed runtime process tree;
- restart tunnel mode;
- inspect MCP health, version, HTTP auth and tunnel readiness;
- enable/disable start-at-logon for the current Windows user.

The MCP/tunnel supervisor and the Control Center supervisor are separate processes. Stopping or restarting the MCP runtime does not stop the Control Center that issued the action. Their state/logs are stored outside the version slot under the per-user runtime directory, and each supervisor validates its recorded process identity before stopping a process tree.

Starting with v0.7.5, start-at-logon uses the current user's `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` registry entry rather than requiring `Register-ScheduledTask`. This avoids `Access is denied` on standard-user Windows installations while preserving a non-elevated, current-user startup boundary. Managed installs point that entry at the stable launcher, so a later version-slot switch does not leave startup pinned to an old release.

Older Scheduled Task registrations are still recognized for status compatibility and are removed on a best-effort basis during registration/unregistration.

## Stable launcher

Managed installs create:

```text
%LOCALAPPDATA%\RemoteWorkstationMCP\bin\rwmcp.ps1
```

Examples:

```powershell
& "$env:LOCALAPPDATA\RemoteWorkstationMCP\bin\rwmcp.ps1" -Action Setup
& "$env:LOCALAPPDATA\RemoteWorkstationMCP\bin\rwmcp.ps1" -Action StartOpenAI
& "$env:LOCALAPPDATA\RemoteWorkstationMCP\bin\rwmcp.ps1" -Action Status
& "$env:LOCALAPPDATA\RemoteWorkstationMCP\bin\rwmcp.ps1" -Action Stop
& "$env:LOCALAPPDATA\RemoteWorkstationMCP\bin\rwmcp.ps1" -Action Update
& "$env:LOCALAPPDATA\RemoteWorkstationMCP\bin\rwmcp.ps1" -Action Rollback
```

`Update` installs the latest verified release into a new slot and switches `current.txt`. `Rollback` swaps back to the previous existing slot. These operations remain owner-local; no MCP tool can invoke them.

## Configuration precedence

Explicit process environment variables remain authoritative. Persisted setup values are imported only when the corresponding environment variable is absent, so temporary owner overrides remain possible.

For managed installs, `policy.yaml` and `hosts.yaml` live in the stable per-user config directory. Repository-development installs can continue using the repository-local config files.

The Setup & Control Center never silently overwrites an existing owner policy or SSH hosts configuration.

## Security boundary

The Control Center deliberately separates **user-level access mode** from **Administrator elevation**.

- **Read only** sets policy mode `read_only`, exposes only `workstation.read`, disables user-level writes/process execution, and keeps host-wide gates off.
- **Workspace** is the default. It enables read/write/execute inside configured workspaces and allows `workstation.admin_request` to create a pending request, but it cannot elevate.
- **Full access** is a persistent local-owner choice. It sets effective `full_control`, adds `workstation.full_control`, and enables host-filesystem + raw-shell gates for the current Windows user. It still does not grant Administrator rights.

Administrator actions use a separate one-shot flow. `admin_request` writes an expiring request containing the exact executable, argv, working directory, reason and requesting principal. The main UI shows that approval card only while a request is active. Local Control Center approval is the mandatory application-level user confirmation. Approval binds the request file by SHA-256 and launches a separate helper through Windows `RunAs`; any additional UAC prompt follows the machine policy. Direct privileged shell hosts such as `cmd.exe` and `powershell.exe` are rejected by the helper; request the target executable directly instead.

The normal MCP/tunnel runtime and Control Center continue to run non-elevated. A mode switch can never silently grant Administrator rights. Do not bind the Control Center to a LAN address, publish it through a reverse proxy, or expose its owner APIs through the Secure MCP Tunnel. Keep it on its dedicated `127.0.0.1` port.
