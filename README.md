# Remote Workstation MCP

**Self-hosted MCP control plane for securely operating engineering workstations from ChatGPT, Codex and other MCP-compatible agents.**

Remote Workstation MCP lets an authorized AI client inspect and edit approved code, use semantic code intelligence, run builds/tests, supervise bounded processes, inspect Git, discover development tools, and execute owner-approved SSH commands. Host-wide shell/filesystem access is enabled only when the local owner selects Full Access. Administrator/UAC actions remain a separate approval path and can never be silently enabled by a mode switch.

> **Security-sensitive beta.** Start with a disposable workspace and the default **Workspace** mode. Select **Full access** only on a trusted owner workstation. Administrator actions always require a separate local approval; elevation then uses Windows RunAs/UAC under the machine policy.

## Current release: v0.7.9

v0.7.9 focuses on **install once, configure once, then use it like a normal workstation service**. It combines the refreshed Tung Lam Control Center from v0.7.8 with the new Windows distribution/update path:

- one-time Windows bootstrap through `install-windows.cmd` or `install-windows.ps1`;
- automatic installation of Node.js LTS and Git through `winget` when they are missing;
- no repository clone, `git pull`, `npm install`, or rebuild required for normal users;
- stable per-user launcher under `%LOCALAPPDATA%\RemoteWorkstationMCP\bin`;
- automatic start after Windows sign-in;
- automatic **stable-channel** update checks on startup, throttled to once per 12 hours;
- verified GitHub Release download + SHA-256 package validation;
- side-by-side version slots, health/readiness validation, and automatic rollback when a new runtime cannot start cleanly;
- failed-release backoff so a broken version is not reinstalled on every sign-in;
- owner settings, policy, SSH hosts, audit data, workspace selection and DPAPI-protected runtime key survive updates;
- simple **Read only / Workspace / Full access** modes;
- Administrator actions remain a separate **owner approval → Windows UAC** path;
- bilingual EN/VI Control Center using the Tung Lam Web UI design system.

The primary design rule remains: **ChatGPT/GPT Web is a first-class controller. Codex, Claude and other coding agents are optional workers, never a required hop.**

---

## Windows — install once

### 1. Download and run the installer

Open the latest GitHub Release and download:

```text
install-windows.cmd
```

Double-click it. The bootstrap downloads `install-windows.ps1` and `SHA256SUMS.txt`, verifies the installer checksum, and then starts the managed installation.

PowerShell fallback:

```powershell
$installer = Join-Path $env:TEMP 'rwmcp-install.ps1'
Invoke-WebRequest `
  'https://github.com/Tunglam0605/remote-workstation-mcp/releases/latest/download/install-windows.ps1' `
  -OutFile $installer
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $installer
```

The installer automatically handles the workstation-side prerequisites, installs the verified runtime in a version slot, installs the pinned OpenAI `tunnel-client`, creates the stable launcher/Start Menu shortcut, initializes stable auto-update, and opens the local Control Center.

### 2. Complete first-time setup

On a new machine, open **Settings** and enter the owner-specific connection values:

1. authorized workspace root;
2. OpenAI Tunnel ID;
3. OpenAI Organization ID when applicable;
4. restricted runtime API key;
5. keep DPAPI secure storage enabled, then choose **Prepare this PC for ChatGPT**.

![Remote Workstation MCP Control Center](docs/images/setup/01-control-center.png)

The setup wizard performs the rest automatically: save configuration, protect the runtime key with Windows DPAPI, create/check workspace and policy, verify the tunnel client, start MCP + the secure tunnel, check readiness, and enable start-at-logon.

Detailed configuration remains behind the Settings modal instead of crowding the daily dashboard:

![Remote Workstation MCP Settings](docs/images/setup/02-settings.png)

### 3. Choose an access mode

Daily use is intentionally reduced to three modes:

- **Read only** — inspect only;
- **Workspace** — read/write/run inside the authorized workspace;
- **Full access** — user-level host filesystem + raw shell.

Full access still does **not** grant Administrator. Administrator requests require a separate local approval and Windows UAC.

![Full access confirmation](docs/images/setup/03-full-access-confirm.png)

### 4. Add the workstation app in ChatGPT

Use the Tunnel ID shown by the Control Center when adding/selecting the Remote Workstation MCP app in ChatGPT. See [ChatGPT Web connection](docs/CHATGPT_WEB.md) for the product-side steps and [end-to-end acceptance](docs/CHATGPT_WEB_CONTROL.md) for the first verification call.

### 5. After the first setup

You do **not** rerun the installer on every boot. After Windows sign-in, the stable launcher automatically:

```text
check stable update if due
        ↓
install verified version into a new slot when available
        ↓
start MCP + OpenAI tunnel
        ↓
verify health/readiness
        ↓
READY
```

If a new runtime fails to start, RWMCP swaps back to the previous version slot and starts the known-good version. A failed release is temporarily suppressed before retrying. Configuration and secrets live outside application version slots, so update/rollback does not require reconfiguration.

Managed Windows layout:

```text
%LOCALAPPDATA%\RemoteWorkstationMCP\
├── current.txt
├── previous.txt
├── settings.json
├── update.json
├── audit.jsonl
├── bin\
│   ├── rwmcp.ps1
│   ├── install-windows-release.ps1
│   └── update-windows.ps1
├── config\
│   ├── policy.yaml
│   └── hosts.yaml
├── runtime\
│   ├── supervisor.json
│   ├── control-center.json
│   ├── permission-lease.json
│   └── admin-approvals\
├── secrets\
│   └── openai-runtime-api-key.dpapi
└── versions\
    ├── v0.7.8\
    └── v0.7.9\
```

Policy, SSH hosts, settings, audit data, update preference and DPAPI secrets live outside version slots.

### Repository-development setup

```powershell
cd "$HOME\Documents"
git clone https://github.com/Tunglam0605/remote-workstation-mcp.git
cd remote-workstation-mcp
git checkout v0.7.9
npm run setup:first-run:windows
```

---

## Setup & Control Center

The managed Windows layout keeps the MCP transport and the owner Control Center on separate loopback ports. A typical installation uses MCP on `127.0.0.1:8683` and the persistent Control Center on `127.0.0.1:8684`. Opening `http://127.0.0.1:8683/` in a browser (or `/setup`) redirects locally to the Control Center, while non-browser/API requests to the MCP root keep the JSON discovery response.

The Control Center is a separate process from the MCP/tunnel runtime, so stopping or restarting MCP does not tear down the page that issued the action. It rejects non-loopback/cross-origin requests and protects its owner APIs with an ephemeral in-memory CSRF token embedded only in the locally served page; the token is neither persisted nor placed in the URL.

For daily use, the main page intentionally exposes only connection health and one access-mode selector: **Read only**, **Workspace** (default), or **Full access**. The selected mode updates the policy and authenticated tunnel scopes; Full access enables user-level host filesystem + raw shell, while Administrator remains separate. Tunnel/runtime/workspace setup opens only when the owner enters **Settings**. If an AI needs an Administrator action, `admin_request` creates a short-lived pending request; the Control Center shows the exact executable/arguments/reason and only a local owner click followed by Windows RunAs/UAC elevation can launch the isolated privileged helper.

Starting with v0.7.5, start-at-logon uses the current-user Windows `Run` registry key rather than `Register-ScheduledTask`. This avoids standard-user `Access is denied` failures and remains non-elevated. The OpenAI start action also waits for tunnel `/readyz` before reporting success, so the quick setup flow does not claim completion while the tunnel is still connecting.

See [Setup & Control Center](docs/SETUP_CONSOLE.md).

---

## ChatGPT Web direct-control path

A cloud-hosted ChatGPT session cannot directly reach workstation loopback. Remote Workstation MCP uses an outbound-only OpenAI Secure MCP Tunnel:

```text
ChatGPT Web custom MCP app
                |
        Secure MCP Tunnel
                |
          tunnel-client
                |
 Authorization: Bearer <ephemeral local token>
                |
      127.0.0.1:<RWMCP_PORT>/mcp
                |
    authenticated request principal
                |
       policy -> mode -> audit
                |
       workstation adapters
```

The workstation MCP never binds publicly. The tunnel provides reachability, **not authorization**. The local MCP bearer is generated for the connection run unless the owner explicitly supplies one. `CONTROL_PLANE_API_KEY` is used by `tunnel-client` but is stripped from the MCP child-process environment.

After adding the custom app in an eligible ChatGPT Web workspace, the first prompt should be:

> Use Remote Workstation. Call `chatgpt_web_status` first. Do not modify anything. Report whether the authenticated control path is verified, the effective scopes, policy mode and authorized workspace names.

A successful tunnel-backed call should report:

```text
chatgptWeb.authenticated: true
chatgptWeb.secureTunnelPrincipal: true
chatgptWeb.directControlPathVerified: true
```

Then verify `workspace_list`, a read (`git_status`/`fs_read`), a disposable workspace write/read-back, and one harmless owner-allowlisted task/process. The default Workspace mode also carries `workstation.admin_request`, which can only create a pending approval; it cannot elevate. `workstation.full_control` remains excluded until the owner selects Full access.

ChatGPT custom-app/MCP availability is product/workspace controlled by OpenAI and can change independently of this repository. As of September 2026, OpenAI documents full custom MCP write/modify support on ChatGPT Web for Business, Enterprise and Edu. Pro has more limited developer-mode MCP support; Plus should not be assumed to support this full write-capable custom-app flow.

See [ChatGPT Web connection](docs/CHATGPT_WEB.md), [end-to-end acceptance](docs/CHATGPT_WEB_CONTROL.md), and [OpenAI Secure MCP Tunnel](docs/OPENAI_SECURE_TUNNEL.md).

---

## Stable Windows launcher

Managed installations create:

```text
%LOCALAPPDATA%\RemoteWorkstationMCP\bin\rwmcp.ps1
```

Examples:

```powershell
$ctl = "$env:LOCALAPPDATA\RemoteWorkstationMCP\bin\rwmcp.ps1"

& $ctl -Action Setup
& $ctl -Action Status
& $ctl -Action UpdateCheck
& $ctl -Action Update
& $ctl -Action AutoUpdateOn
& $ctl -Action AutoUpdateOff
& $ctl -Action Rollback
```

Windows start-at-logon uses the launcher `Boot` action automatically. `Boot` performs a throttled stable update check before starting OpenAI mode. Manual `Update` installs the latest verified release into a new slot and validates it; `Rollback` swaps back to the previous existing slot. These are owner-local actions and are not exposed as MCP tools.

---

## Architecture

```text
Owner-local surfaces
Setup & Control Center / stable launcher
               |
               v
      persisted owner state
               |
Local clients  |                  OpenAI-hosted clients
Codex/Cursor   |                  ChatGPT/Responses
      |        |                         |
 stdio/HTTP    |                  Secure MCP Tunnel
      |        |                         |
      +--------+-------------+-----------+
                              v
                 +-------------------------+
                 | Remote Workstation MCP  |
                 | loopback / local user   |
                 +------------+------------+
                              |
                  authenticated principal
                              |
                      policy -> mode
                              |
                           audit
                              |
        +----------+----------+----------+----------+
        |          |          |          |          |
       FS         Git        LSP       Process     SSH
```

Routine engineering operations use typed adapters. Raw shell remains an explicitly elevated escape hatch.

---

## MCP capabilities

| Area | Tools / surface |
| --- | --- |
| ChatGPT Web verification | `chatgpt_web_status` |
| Discovery | `capabilities_list`, `system_info`, `tool_discover`, `update_check` |
| Workspaces/files | `workspace_list`, `fs_list`, `fs_find`, `fs_search_text`, `fs_read`, `fs_write`, `fs_patch` |
| Git | `git_status`, `git_diff`, `git_log`, `git_branches`, `git_add`, `git_commit`, `git_branch_create`, `git_branch_switch`, `git_worktree_list`, `git_worktree_add`, `git_worktree_remove` |
| Semantic code | `lsp_servers`, `lsp_definition`, `lsp_references`, `lsp_hover`, `lsp_document_symbols`, `lsp_diagnostics` |
| Build/run | `task_list`, `task_run`, `build_diagnostics`, `process_start`, `process_write`, `process_close_stdin`, `process_read`, `process_read_since`, `process_list`, `process_stop` |
| SSH | `ssh_hosts`, `ssh_probe`, `ssh_exec` |
| Permission state | `permission_status` |
| Administrator request | `admin_request`, `admin_request_status` (request/status only; local Control Center approval required before Windows RunAs/UAC elevation) |
| Optional full user control | `host_fs_list`, `host_fs_read`, `host_fs_write`, `shell_exec` |
| Owner-local distribution | Setup & Control Center, Windows release installer, runtime supervisor, update/rollback pointers |

A true PTY/ConPTY layer, DAP/GDB adapters, serial/probe tooling and ROS 2 typed adapters are later roadmap work. Plugin-first multi-device pairing is intentionally deferred until the direct ChatGPT Web path is accepted on a real workspace.

---

## Security properties

- Safe default mode is workspace-scoped.
- Local HTTP binds to `127.0.0.1` only.
- Secure MCP Tunnel is outbound-only.
- Local policy/hosts and owner mode selection are not writable through MCP. AI-created Administrator records are request-only and cannot self-approve.
- Setup/control APIs require an ephemeral local setup token and same-origin browser access.
- Windows runtime API key persistence uses current-user DPAPI and is separate from `settings.json`.
- Windows start-at-logon uses the current-user registry hive and does not elevate privileges.
- Normal process execution uses executable + argv with `shell: false` and an owner allowlist.
- Child-process environment inheritance is allowlisted and secret-like variable names are filtered.
- Workspace filesystem paths are canonicalized after symlink/reparse resolution.
- File mutations can require SHA-256 preconditions.
- Managed process sessions are principal-owned.
- LSP servers are executable-allowlisted and workspace-bounded.
- SSH uses named owner-approved hosts, BatchMode auth, strict host-key policy, forwarding disabled and per-host executable allowlists.
- Full user-level capabilities require authenticated `workstation.full_control` plus effective Full access and the explicit local feature gate; legacy client-bound leases remain an alternate compatibility path.
- Administrator execution is separate: the AI can only create a pending request; local Control Center approval and exact-request SHA-256 binding are mandatory, then Windows RunAs/UAC elevation follows the machine policy.
- The normal MCP/tunnel/Control Center processes remain non-elevated.
- Windows release packages are verified against published SHA-256 before installation.

### Important boundary: this is not an OS sandbox

Workspace path guards protect the built-in filesystem tools. An authorized compiler, interpreter, build script, debugger, language server or raw shell still executes with the OS rights of the account running Remote Workstation MCP.

Use a VM/container/OS sandbox for untrusted code.

See [Security](docs/SECURITY.md) and [Threat model](docs/THREAT_MODEL.md).

---

## Requirements

Managed Windows install:

- Windows 10/11;
- Windows PowerShell 5.1+;
- network access to GitHub Releases;
- `winget` recommended for one-time automatic Node.js LTS + Git installation (otherwise preinstall them);
- OpenSSH client only when SSH tools are needed.

The OpenAI tunnel path additionally requires a Tunnel ID, suitable runtime API key and supported `tunnel-client`. The Windows installer installs the pinned verified tunnel-client build.

Linux managed installation remains available through:

```bash
git clone https://github.com/Tunglam0605/remote-workstation-mcp.git
cd remote-workstation-mcp
npm run install:user
npm run doctor
```

---

## Plugin package

The repository also ships portable Agent Plugin / Codex metadata:

```text
.agents/plugins/marketplace.json
plugins/remote-workstation/
├── plugin.json
├── mcp.json
├── .codex-plugin/plugin.json
├── .mcp.json
└── skills/
    └── workstation-operator/
        └── SKILL.md
```

Portable local plugin mappings and ChatGPT Web attachment are separate layers. Web-hosted ChatGPT should use the Secure MCP Tunnel path rather than exposing a workstation listener.

Example Codex marketplace install:

```bash
codex plugin marketplace add Tunglam0605/remote-workstation-mcp --ref v0.7.9
codex plugin marketplace list
```

See [Plugin installation](docs/PLUGIN_INSTALL.md).

---

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
npm run plugin:validate
bash scripts/smoke-package.sh
```

CI validates Linux and Windows builds, tests, plugin manifests, Windows DPAPI persistence, user-level start-at-logon, the managed runtime supervisor and the packed production artifact.

## Documentation

- [Windows install-once quick start](docs/QUICKSTART_WINDOWS.md)
- [Setup & Control Center](docs/SETUP_CONSOLE.md)
- [ChatGPT Web connection](docs/CHATGPT_WEB.md)
- [ChatGPT Web end-to-end acceptance](docs/CHATGPT_WEB_CONTROL.md)
- [OpenAI Secure MCP Tunnel](docs/OPENAI_SECURE_TUNNEL.md)
- [Windows runtime](docs/WINDOWS.md)
- [Plugin installation](docs/PLUGIN_INSTALL.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Transport providers](docs/TRANSPORTS.md)
- [LSP](docs/LSP.md)
- [Interactive processes](docs/INTERACTIVE_PROCESSES.md)
- [Client integrations](docs/CLIENTS.md)
- [Operations](docs/OPERATIONS.md)
- [Multi-agent design](docs/MULTI_AGENT.md)
- [Security](docs/SECURITY.md)
- [Threat model](docs/THREAT_MODEL.md)
- [Privacy](docs/PRIVACY.md)
- [Plugin usage terms](docs/PLUGIN_TERMS.md)
- [Roadmap](docs/ROADMAP.md)

## License

Apache-2.0
