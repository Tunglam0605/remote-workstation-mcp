# Local Setup & Control Center

Remote Workstation MCP v0.7.5 provides an owner-operated **Setup & Control Center** for Windows while keeping it outside the MCP tool surface.

The Control Center is **not** exposed through the OpenAI tunnel. It binds only to `127.0.0.1`, uses an ephemeral setup token, rejects non-loopback clients, applies a same-origin check, sends `Cache-Control: no-store`, and never offers controls for full-control policy gates or permission leases.

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
│   └── supervisor.stderr.log
├── secrets\
│   └── openai-runtime-api-key.dpapi
└── versions\
    ├── v0.7.4\
    └── v0.7.5\
```

Policy/hosts/settings/secrets are therefore not replaced when the application version changes.

## What the Control Center configures

The web flow can configure:

- MCP loopback port (`RWMCP_PORT` equivalent), with automatic free-port recommendation;
- authorized workspace root for a new default policy;
- OpenAI Secure MCP Tunnel ID;
- OpenAI organization ID;
- managed Cloudflare runtime opt-in/out;
- official OpenAI `tunnel-client` installation on Windows;
- OpenAI runtime API key storage using current-user Windows DPAPI.

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

The background supervisor state/logs are stored outside the version slot under the per-user runtime directory. The supervisor validates its recorded process before stopping a process tree so a stale PID file is not treated as sufficient authority.

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

The browser UI deliberately does **not** provide controls for:

- `fullControl.allowRawShell`;
- host-wide filesystem access;
- sudo/Administrator execution;
- permission lease creation/extension;
- authenticated `workstation.full_control` scope grants.

Those remain explicit local-owner security operations outside the web UI.

Do not bind the Control Center to a LAN address, publish it through a reverse proxy, or expose it through the Secure MCP Tunnel.
