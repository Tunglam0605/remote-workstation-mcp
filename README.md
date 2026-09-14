# Remote Workstation MCP

**Self-hosted MCP control plane for securely operating engineering workstations from ChatGPT, Codex and other MCP-compatible agents.**

Remote Workstation MCP lets an authorized AI client inspect and edit approved code, use semantic code intelligence, run builds/tests, supervise bounded processes, inspect Git, discover development tools, and execute owner-approved SSH commands. Host-wide shell/filesystem access remains disabled unless the owner explicitly enables local gates and grants a short-lived client-bound lease.

> **Security-sensitive beta.** Start with a disposable workspace. Keep full-control gates disabled until local policy, audit records, principal identity and tunnel behavior have been validated.

## Current release: v0.7.3

The v0.7 line establishes direct workstation control and practical Windows distribution:

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
- local-only Setup & Control Center;
- checksum-verified per-user Windows release installation;
- version slots, stable launcher, update pointer and rollback pointer;
- optional current-user start-at-logon without Administrator privileges.

The primary design rule is unchanged: **ChatGPT/GPT Web is a first-class controller. Codex, Claude and other coding agents are optional workers, never a required hop.**

---

## Fastest Windows installation

A production/new-machine install does **not** require cloning the repository.

Download the release installer, inspect it if desired, then run it:

```powershell
$installer = Join-Path $env:TEMP 'rwmcp-install.ps1'
Invoke-WebRequest `
  'https://github.com/Tunglam0605/remote-workstation-mcp/releases/latest/download/install-windows.ps1' `
  -OutFile $installer
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File $installer
```

The installer resolves the release, downloads the package + `SHA256SUMS.txt`, verifies SHA-256, installs a versioned runtime under the current Windows user, installs the pinned OpenAI `tunnel-client`, creates a stable launcher and opens the local Setup & Control Center.

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
│   └── supervisor.stderr.log
├── secrets\
│   └── openai-runtime-api-key.dpapi
└── versions\
    └── vX.Y.Z\
```

Policy, SSH hosts, settings, audit data and DPAPI secrets live outside the version slot, so application updates do not replace owner configuration.

### Repository-development setup

For contributors or source-tree development:

```powershell
cd "$HOME\Documents"
git clone https://github.com/Tunglam0605/remote-workstation-mcp.git
cd remote-workstation-mcp
git checkout v0.7.3
npm run setup:first-run:windows
```

---

## Setup & Control Center

The local web UI binds only to `127.0.0.1`. It uses an ephemeral setup token, rejects non-loopback clients and cross-origin API calls, and is never exposed as an MCP tool or through the OpenAI tunnel.

It supports:

- selecting a free MCP loopback port;
- choosing the authorized workspace root;
- storing Tunnel ID and organization context;
- Windows DPAPI protection for the runtime API key;
- installing/verifying the pinned OpenAI `tunnel-client`;
- local MCP start;
- OpenAI tunnel start;
- stop/restart;
- MCP health/version/auth status;
- tunnel readiness status;
- enable/disable current-user start-at-logon.

It deliberately does **not** expose controls for raw-shell gates, host-wide filesystem gates, Administrator/sudo execution, permission leases or `workstation.full_control` grants.

See [Setup & Control Center](docs/SETUP_CONSOLE.md).

---

## ChatGPT Web path

A cloud-hosted ChatGPT session cannot directly reach workstation loopback. Remote Workstation MCP uses an outbound-only OpenAI Secure MCP Tunnel:

```text
ChatGPT / OpenAI-hosted MCP consumer
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

The workstation MCP never binds publicly. The tunnel is reachability, **not authorization**.

The local MCP bearer is generated for the connection run unless the owner explicitly supplies one. `CONTROL_PLANE_API_KEY` is used by `tunnel-client` but is stripped from the MCP child process environment.

ChatGPT custom-app/MCP availability is product/workspace controlled by OpenAI and can change independently of this repository. The workstation/tunnel stack can still be installed and health-checked without that entitlement.

See [ChatGPT Web connection](docs/CHATGPT_WEB.md) and [OpenAI Secure MCP Tunnel](docs/OPENAI_SECURE_TUNNEL.md).

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
| Discovery | `capabilities_list`, `system_info`, `tool_discover`, `update_check` |
| Workspaces/files | `workspace_list`, `fs_list`, `fs_find`, `fs_search_text`, `fs_read`, `fs_write`, `fs_patch` |
| Git | `git_status`, `git_diff`, `git_log`, `git_branches`, `git_add`, `git_commit`, `git_branch_create`, `git_branch_switch`, `git_worktree_list`, `git_worktree_add`, `git_worktree_remove` |
| Semantic code | `lsp_servers`, `lsp_definition`, `lsp_references`, `lsp_hover`, `lsp_document_symbols`, `lsp_diagnostics` |
| Build/run | `task_list`, `task_run`, `build_diagnostics`, `process_start`, `process_write`, `process_close_stdin`, `process_read`, `process_read_since`, `process_list`, `process_stop` |
| SSH | `ssh_hosts`, `ssh_probe`, `ssh_exec` |
| Permission state | `permission_status` |
| Optional full user control | `host_fs_list`, `host_fs_read`, `host_fs_write`, `shell_exec` |
| Owner-local distribution | Setup & Control Center, Windows release installer, runtime supervisor, update/rollback pointers |

A true PTY/ConPTY layer, DAP/GDB adapters, serial/probe tooling and ROS 2 typed adapters are v0.8 roadmap work.

---

## Security properties

- Safe default mode is workspace-scoped.
- Local HTTP binds to `127.0.0.1` only.
- Secure MCP Tunnel is outbound-only.
- Local policy/hosts/leases are not writable through MCP.
- Setup/control APIs require an ephemeral local token and same-origin browser access.
- Windows runtime API key persistence uses current-user DPAPI and is separate from `settings.json`.
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
codex plugin marketplace add Tunglam0605/remote-workstation-mcp --ref v0.7.3
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

CI validates Linux and Windows builds, tests, plugin manifests, Windows DPAPI persistence, the managed runtime supervisor and the packed production artifact.

## Documentation

- [Setup & Control Center](docs/SETUP_CONSOLE.md)
- [ChatGPT Web connection](docs/CHATGPT_WEB.md)
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
