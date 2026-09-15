# Remote Workstation MCP

**Self-hosted MCP control plane for securely operating engineering workstations from ChatGPT, Codex and other MCP-compatible agents.**

Remote Workstation MCP lets an authorized AI client inspect and edit approved code, use semantic code intelligence, run builds/tests, supervise bounded processes, inspect Git, discover development tools, and execute owner-approved SSH commands. Host-wide shell/filesystem access remains disabled unless the owner explicitly enables local gates and grants a short-lived client-bound lease.

> **Security-sensitive beta.** Start with a disposable workspace. Keep full-control gates disabled until local policy, audit records, principal identity and tunnel behavior have been validated.

## Current release: v0.7.6

The v0.7 line establishes direct workstation control, practical Windows distribution, and a deterministic ChatGPT Web acceptance path. v0.7.6 adds a persistent owner Control Center, bilingual EN/VI UI, explicit permission controls, and a safer full-control workflow:

- authenticated request principals and workstation scopes;
- workspace filesystem + optimistic SHA-256 writes;
- typed Git branches/commits/worktrees;
- LSP definitions, references, hover, symbols and diagnostics;
- bounded managed processes with incremental output and stdin;
- structured compiler/build diagnostics;
- approved SSH hosts and program allowlists;
- owner-controlled time-limited elevation/full-control leases;
- outbound-only OpenAI Secure MCP Tunnel support;
- Windows DPAPI storage for the OpenAI runtime API key;
- persistent local-only Setup & Control Center on a dedicated loopback port, with browser redirect from the MCP root;
- bilingual English/Vietnamese Control Center with remembered language selection;
- owner UI for read/write/execute/full-control tunnel scopes, host-filesystem/raw-shell gates, and short client-bound full-control leases;
- checksum-verified per-user Windows release installation;
- version slots, stable launcher, update pointer and rollback pointer;
- current-user start-at-logon through `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, without Administrator privileges;
- deterministic OpenAI tunnel readiness before `StartOpenAI` reports success;
- `chatgpt_web_status` for first-call verification from ChatGPT Web.

The primary design rule is unchanged: **ChatGPT/GPT Web is a first-class controller. Codex, Claude and other coding agents are optional workers, never a required hop.**

---

## Fastest Windows installation

A production/new-machine install does **not** require cloning the repository.

```powershell
$installer = Join-Path $env:TEMP 'rwmcp-install.ps1'
Invoke-WebRequest `
  'https://github.com/Tunglam0605/remote-workstation-mcp/releases/latest/download/install-windows.ps1' `
  -OutFile $installer
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File $installer
```

The installer resolves the latest release, downloads the package + `SHA256SUMS.txt`, verifies SHA-256, installs a versioned runtime under the current Windows user, installs the pinned OpenAI `tunnel-client`, creates a stable launcher and opens the local Setup & Control Center.

Managed Windows layout:

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
│   └── permission-lease.json
├── secrets\
│   └── openai-runtime-api-key.dpapi
└── versions\
    └── vX.Y.Z\
```

Policy, SSH hosts, settings, audit data and DPAPI secrets live outside the version slot, so application updates do not replace owner configuration.

### Repository-development setup

```powershell
cd "$HOME\Documents"
git clone https://github.com/Tunglam0605/remote-workstation-mcp.git
cd remote-workstation-mcp
git checkout v0.7.6
npm run setup:first-run:windows
```

---

## Setup & Control Center

The managed Windows layout keeps the MCP transport and the owner Control Center on separate loopback ports. A typical installation uses MCP on `127.0.0.1:8683` and the persistent Control Center on `127.0.0.1:8684`. Opening `http://127.0.0.1:8683/` in a browser (or `/setup`) redirects locally to the Control Center, while non-browser/API requests to the MCP root keep the JSON discovery response.

The Control Center is a separate process from the MCP/tunnel runtime, so stopping or restarting MCP does not tear down the page that issued the action. It rejects non-loopback/cross-origin requests and protects its owner APIs with an ephemeral in-memory CSRF token embedded only in the locally served page; the token is neither persisted nor placed in the URL.

It supports workspace/tunnel configuration, DPAPI-protected runtime-key storage, tunnel-client installation, runtime health/control, start-at-logon, and explicit permission management. The Permissions card can change write/execute/full-control tunnel scopes, the host-filesystem/raw-shell local gates, and short `full_control` leases (10/30/60 minutes) bound to `openai-tunnel`. Full-control still requires scope + gate + active lease; Administrator/sudo remains unavailable. Safe defaults stay read/write/execute, dangerous gates off and no lease.

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
       policy -> lease -> audit
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

Then verify `workspace_list`, a read (`git_status`/`fs_read`), a disposable workspace write/read-back, and one harmless owner-allowlisted task/process. `workstation.full_control` is intentionally excluded from the default tunnel scope.

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
& $ctl -Action StartOpenAI
& $ctl -Action Status
& $ctl -Action Stop
& $ctl -Action AutostartOn
& $ctl -Action AutostartOff
& $ctl -Action Update
& $ctl -Action Rollback
```

`Update` installs the latest verified release in a new slot and moves `current.txt`. `Rollback` swaps back to the previous existing slot. These are local-owner actions and are not exposed as MCP tools.

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
                     policy -> leases
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
| Optional full user control | `host_fs_list`, `host_fs_read`, `host_fs_write`, `shell_exec` |
| Owner-local distribution | Setup & Control Center, Windows release installer, runtime supervisor, update/rollback pointers |

A true PTY/ConPTY layer, DAP/GDB adapters, serial/probe tooling and ROS 2 typed adapters are later roadmap work. Plugin-first multi-device pairing is intentionally deferred until the direct ChatGPT Web path is accepted on a real workspace.

---

## Security properties

- Safe default mode is workspace-scoped.
- Local HTTP binds to `127.0.0.1` only.
- Secure MCP Tunnel is outbound-only.
- Local policy/hosts/leases are not writable through MCP.
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
- Full-control capabilities require authenticated scope + active owner lease + explicit local feature gate.
- The AI cannot create, extend or revoke its own permission lease.
- Root/Administrator execution is not exposed by the normal MCP process.
- Windows release packages are verified against published SHA-256 before installation.

### Important boundary: this is not an OS sandbox

Workspace path guards protect the built-in filesystem tools. An authorized compiler, interpreter, build script, debugger, language server or raw shell still executes with the OS rights of the account running Remote Workstation MCP.

Use a VM/container/OS sandbox for untrusted code.

See [Security](docs/SECURITY.md) and [Threat model](docs/THREAT_MODEL.md).

---

## Requirements

Managed Windows install:

- Windows 10/11;
- PowerShell 5.1+;
- network access to GitHub Releases;
- Node.js 22+, npm and Git (installer can use `winget` when available);
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
codex plugin marketplace add Tunglam0605/remote-workstation-mcp --ref v0.7.6
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
