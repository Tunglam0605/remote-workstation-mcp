# Remote Workstation MCP

**Installable ChatGPT/Codex plugin + AI-vendor-neutral MCP control plane for engineering workstations.**

Remote Workstation MCP lets compatible AI clients inspect and edit approved code, use semantic code intelligence, run builds/tests, supervise bounded interactive processes, inspect Git, discover development tools, and execute owner-approved SSH commands. Optional host-level shell/filesystem access remains disabled until the owner explicitly enables local policy gates and grants a short-lived client-bound lease.

> **v0.7 is security-sensitive beta software.** Start with a disposable workspace and keep full-control gates disabled until you have validated your local policy, audit records, and client identity flow.

## What changed in v0.7

v0.7 turns the project from a local MCP runtime into a stronger direct engineering-control plane:

- owner-configured LSP semantic tools: definition, references, hover, document symbols, diagnostics;
- typed Git history/branch/worktree management for safer multi-agent isolation;
- bounded interactive managed-process stdin through `process_write` and `process_close_stdin`;
- request-scoped authenticated HTTP principals and scope enforcement;
- transport-provider separation between stdio and loopback Streamable HTTP;
- optional **OpenAI Secure MCP Tunnel** connection provider for ChatGPT/cloud use while the workstation MCP stays bound to `127.0.0.1`;
- Windows + Linux CI coverage for the direct-control core.

v0.7.1 hardens the first real Windows tunnel path: Windows launchers print the effective `RWMCP_PORT`, managed Cloudflare runtime material is opt-in instead of a startup dependency, organization context is documented, and tunnel readiness verification is explicit.

The OpenAI tunnel path is deliberately outside the workstation execution core: transport, authentication, policy, leases, audit, path protection, process ownership, Git/LSP adapters, and SSH remain local security authorities.

## Quick start on Windows

```powershell
cd "$HOME\Documents"
git clone https://github.com/Tunglam0605/remote-workstation-mcp.git
cd remote-workstation-mcp
git checkout v0.7.1
npm run setup:windows
npm run start:windows
```

If port `8765` is already used by another local MCP/plugin, select another loopback port before starting:

```powershell
$env:RWMCP_PORT = "8683"
npm run start:windows
```

Verify from another PowerShell window using the configured port:

```powershell
Invoke-RestMethod http://127.0.0.1:8683/healthz
```

Expected fields include:

```text
ok      : True
version : 0.7.1
mode    : workspace
```

The safe default workspace is:

```text
%USERPROFILE%\Documents\RemoteWorkspaces
```

See [Windows runtime](docs/WINDOWS.md) for details.

## ChatGPT/cloud access through OpenAI Secure MCP Tunnel

A web-hosted ChatGPT session cannot directly reach `127.0.0.1` on your workstation. v0.7 adds an outbound-only Secure MCP Tunnel supervisor rather than asking you to expose the workstation MCP port publicly.

On Windows, after normal setup:

```powershell
npm run openai:tunnel:install:windows
$env:RWMCP_PORT = "8683" # optional custom loopback port
$env:CONTROL_PLANE_TUNNEL_ID = "tunnel_0123456789abcdef0123456789abcdef"
$env:CONTROL_PLANE_ORGANIZATION_ID = "org_example" # recommended for org-scoped tunnels
$env:CONTROL_PLANE_API_KEY = "<runtime-api-key>"
npm run start:openai:windows
```

The installer pins the official OpenAI `tunnel-client` v0.0.14 Windows AMD64 release and verifies its published SHA-256 before extraction. The supervisor then:

1. starts Remote Workstation MCP on loopback with bearer authentication;
2. generates a fresh local MCP bearer unless the owner supplied one;
3. generates a tunnel profile containing only environment references for secrets;
4. runs `tunnel-client doctor` before daemon startup;
5. starts the outbound tunnel and waits for its `/readyz` endpoint;
6. stops MCP and tunnel together when the session ends.

Managed Cloudflare runtime material is optional and disabled by default in v0.7.1. Only set `CLOUDFLARED_MANAGED=true` when the selected logical tunnel actually has managed Cloudflare runtime material provisioned. A `404 Managed Cloudflare tunnel runtime material not found` response is a signal to keep managed mode disabled, not an MCP authentication failure.

The OpenAI runtime API key is **not forwarded into the MCP child process**. The default tunnel principal scopes are `workstation.read,workstation.write,workstation.execute`; full-control still requires explicit full-control scope, a time-limited owner lease, and the corresponding dangerous-feature gate.

See [OpenAI Secure MCP Tunnel](docs/OPENAI_SECURE_TUNNEL.md) for the complete trust boundary and current OpenAI setup flow.

## Plugin package

The repository is also packaged as an OpenAI Agent Plugin / Codex-compatible plugin:

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

The bundled local MCP mapping remains:

```text
http://127.0.0.1:8765/mcp
```

That static mapping is for portable local plugin compatibility. If another local plugin already owns `8765`, either customize the local integration or use the Secure MCP Tunnel path, which follows `RWMCP_PORT` dynamically.

For repo/local plugin development, the workstation runtime must be running on the same machine. For ChatGPT/cloud reachability, use the Secure MCP Tunnel path instead of public port-forwarding.

Example Codex marketplace setup:

```bash
codex plugin marketplace add Tunglam0605/remote-workstation-mcp --ref v0.7.1
codex plugin marketplace list
```

See [Plugin installation](docs/PLUGIN_INSTALL.md) for packaging and compatibility details.

## Architecture

```text
Local clients                         OpenAI-hosted clients
Codex / Cursor / Claude               ChatGPT / Responses / Codex
        |                                      |
   stdio / loopback HTTP                Secure MCP Tunnel
        |                                      |
        +------------------+-------------------+
                           v
              +---------------------------+
              | Remote Workstation MCP    |
              | loopback / local process  |
              +-------------+-------------+
                            |
              authenticated principal/scope
                            |
              policy -> leases -> audit
                            |
       +--------------------+---------------------+
       |          |          |         |          |
      FS         Git        LSP     Process      SSH
       |          |          |         |          |
 approved     branches/   semantic   build/     approved
 workspaces   worktrees     code     stdin I/O   hosts
```

The connection provider does not bypass MCP authorization. File contents, tool output, source code, Git data, language-server responses, and remote SSH output are all treated as untrusted input.

## Current capabilities

| Area | MCP tools |
| --- | --- |
| Discovery | `capabilities_list`, `system_info`, `tool_discover`, `update_check` |
| Workspaces/files | `workspace_list`, `fs_list`, `fs_find`, `fs_search_text`, `fs_read`, `fs_write`, `fs_patch` |
| Git | `git_status`, `git_diff`, `git_log`, `git_branches`, `git_add`, `git_commit`, `git_branch_create`, `git_branch_switch`, `git_worktree_list`, `git_worktree_add`, `git_worktree_remove` |
| Semantic code | `lsp_servers`, `lsp_definition`, `lsp_references`, `lsp_hover`, `lsp_document_symbols`, `lsp_diagnostics` |
| Build/run | `task_list`, `task_run`, `build_diagnostics`, `process_start`, `process_write`, `process_close_stdin`, `process_read`, `process_read_since`, `process_list`, `process_stop` |
| SSH | `ssh_hosts`, `ssh_probe`, `ssh_exec` |
| Permission state | `permission_status` |
| Optional full user control | `host_fs_list`, `host_fs_read`, `host_fs_write`, `shell_exec` |

A true PTY/ConPTY terminal layer and an isolated root/Administrator helper are still separate future capabilities. v0.7 process interaction is bounded pipe-backed stdin/stdout, not terminal emulation.

## Security properties

- Safe default mode is workspace-scoped.
- Local policy is never writable through MCP.
- Workspace paths are canonicalized after symlink/reparse resolution.
- Normal process execution uses executable + argv with `shell: false` and an owner allowlist.
- Managed processes and their output/stdin are isolated to the creating authenticated principal or fallback local client profile.
- Child-process environments are allowlisted and secret-like variable names are filtered.
- File writes support SHA-256 optimistic concurrency for concurrent agents.
- Git worktrees are the preferred isolation boundary for larger parallel coding tasks.
- LSP servers are owner-configured, executable-allowlisted, principal-scoped, message-size/time bounded, and redact workspace-external locations.
- SSH uses named owner-approved hosts, BatchMode authentication, strict host-key policy, forwarding disabled, and per-host executable allowlists.
- Full-control features require an active time-limited local lease plus explicit local dangerous-feature gates.
- Authenticated HTTP tools require registered workstation scopes and fail closed for unclassified tools.
- The AI cannot grant, extend, or revoke its own permission lease.
- HTTP transport binds to `127.0.0.1` only.
- Secure MCP Tunnel is outbound-only; no public listener is added to the workstation runtime.
- The managed Linux service uses `NoNewPrivileges=true`.
- Plugin/package validation runs in CI on Linux and Windows before release publication.

### Important boundary

The workspace path guard protects built-in filesystem tools. It is **not an OS sandbox for child processes**. A compiler, interpreter, build script, debugger, language server, or raw shell you authorize runs with the operating-system permissions of the account running Remote Workstation MCP. Only allow tools and projects you trust.

## Requirements

Core runtime:

- Node.js 22+
- npm
- Git
- OpenSSH client when SSH tools are used
- Windows 10/11 or Linux/Ubuntu

OpenAI Secure MCP Tunnel additionally requires an OpenAI tunnel id, a runtime API key with Tunnels Read + Use, and a supported `tunnel-client` binary. The Windows helper installs and verifies the pinned official release; other platforms can provide `tunnel-client` through `PATH` or `RWMCP_OPENAI_TUNNEL_CLIENT`.

## Managed Linux installation

```bash
git clone https://github.com/Tunglam0605/remote-workstation-mcp.git
cd remote-workstation-mcp
npm run install:user
```

The installer validates/builds the project, installs a versioned runtime, creates safe local config, and starts a `systemd --user` service.

```text
~/.local/share/remote-workstation-mcp/
├── versions/<version>/
├── current -> versions/<version>
├── previous -> ...
└── runtime/

~/.config/remote-workstation-mcp/
├── policy.yaml
├── hosts.yaml
└── update.env
```

Default workspace:

```text
~/RemoteWorkspaces
```

Service endpoints:

```text
MCP:    http://127.0.0.1:8765/mcp
Health: http://127.0.0.1:8765/healthz
```

Validate:

```bash
npm run doctor
systemctl --user status remote-workstation-mcp.service
curl -fsS http://127.0.0.1:8765/healthz
```

## Local stdio clients

```bash
cp config/policy.example.yaml config/policy.yaml
npm install
npm run build
RWMCP_POLICY="$PWD/config/policy.yaml" \
RWMCP_CLIENT_ID=my-agent \
RWMCP_CLIENT_TYPE=mcp \
node "$PWD/dist/cli.js" --stdio
```

Use a distinct `RWMCP_CLIENT_ID` for dedicated local profiles when leases or audit records should be associated with a specific client.

## LSP semantic code intelligence

Language servers are inert until the owner configures them and allowlists their executable. Example:

```yaml
process:
  allowExecutables:
    - clangd

lsp:
  requestTimeoutMs: 10000
  maxMessageBytes: 2097152
  diagnosticsSettleMs: 250
  servers:
    clangd:
      program: clangd
      args: [--background-index]
      languages:
        .c: c
        .h: c
        .cpp: cpp
        .hpp: cpp
```

See [LSP](docs/LSP.md).

## Build/test task profiles

```yaml
tasks:
  firmware-build:
    program: cmake
    args: [--build, build]
    cwd: .
  tests:
    program: npm
    args: [test]
    cwd: .
```

The task program must also be present in `process.allowExecutables`.

## SSH remote machines

Configure only explicitly authorized hosts in `hosts.yaml`:

```yaml
version: 1
hosts:
  - id: robot-pc
    hostname: 192.168.1.100
    port: 22
    user: robot
    auth: agent
    strictHostKeyChecking: yes
    remoteRoot: /home/robot/projects
    allowPrograms: [git, python3, cmake, ninja, make]
    maxRuntimeMs: 600000
```

Prefer `ssh-agent`. Password authentication is intentionally not implemented.

## Temporary full user-level control

Full-control tools are disabled by default. The owner must explicitly enable only the needed local gates and create a short lease.

Example local gates:

```yaml
fullControl:
  allowRawShell: true
  allowHostFilesystem: true
```

Example owner-issued lease:

```bash
node scripts/grant-permission.mjs \
  --mode full_control \
  --ttl 30m \
  --client-id openai-tunnel \
  --reason "interactive engineering session"
```

The authenticated principal also needs `workstation.full_control`. A lease alone never bypasses a disabled feature gate or a missing authenticated scope.

## Updates and rollback

The managed Linux installer supports notify/automatic update modes and versioned rollback. Release packages are checked against `SHA256SUMS.txt`, installed into a new version slot, health checked after restart, and rolled back on failure.

```bash
node scripts/update-user.mjs --check
node scripts/update-user.mjs
bash scripts/rollback-user.sh
```

## Documentation

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

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
npm run plugin:validate
bash scripts/smoke-package.sh
```

CI validates source, tests, portable/compatibility plugin manifests, local doctor behavior, Windows loopback HTTP, and the packed production artifact before release publication.

## License

Apache-2.0
