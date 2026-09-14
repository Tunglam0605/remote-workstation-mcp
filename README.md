# Remote Workstation MCP

**Installable ChatGPT/Codex plugin + AI-vendor-neutral MCP control plane for engineering workstations.**

Remote Workstation MCP lets compatible AI clients inspect and edit approved code, search workspaces, run builds/tests, supervise long-running processes, discover installed tools, and execute owner-approved SSH commands. Optional host-level shell/filesystem access remains disabled until the owner explicitly enables local policy gates and grants a short-lived client-bound lease.

> **v0.6 is security-sensitive beta software.** Start with a disposable workspace. Keep full-control gates disabled until you have validated your local policy and audit flow.

## What changed in v0.6

The repository is now packaged as an **OpenAI Agent Plugin** in addition to being an MCP server. It contains:

```text
.agents/plugins/marketplace.json
plugins/remote-workstation/
├── plugin.json                    # portable Agent Plugins manifest
├── mcp.json                       # portable MCP mapping
├── .codex-plugin/plugin.json      # OpenAI/Codex compatibility manifest
├── .mcp.json                      # legacy compatibility MCP mapping
└── skills/
    └── workstation-operator/
        └── SKILL.md
```

This means the repository can be added as a marketplace source and **Remote Workstation** can be installed from the Plugins Directory in supported ChatGPT desktop/Codex surfaces.

## Install as a ChatGPT plugin

### 1. Install the workstation runtime

On the Ubuntu/Linux workstation that you want the AI to operate:

```bash
git clone https://github.com/Tunglam0605/remote-workstation-mcp.git
cd remote-workstation-mcp
git checkout v0.6.0
npm run install:user
npm run doctor
```

Verify the local MCP server:

```bash
curl -fsS http://127.0.0.1:8765/healthz
```

Expected response includes:

```json
{
  "ok": true,
  "version": "0.6.0"
}
```

### 2. Add this GitHub repository as a plugin marketplace

From Codex CLI on the same computer:

```bash
codex plugin marketplace add Tunglam0605/remote-workstation-mcp --ref v0.6.0
```

For development against the current repository head instead of a pinned release:

```bash
codex plugin marketplace add Tunglam0605/remote-workstation-mcp --ref main
```

Inspect configured marketplaces:

```bash
codex plugin marketplace list
```

### 3. Install from ChatGPT desktop

Restart the ChatGPT desktop app, open **Plugins Directory**, choose the **TungLam Remote Workstation** marketplace, select **Remote Workstation**, and install it.

The bundled local plugin connects to:

```text
http://127.0.0.1:8765/mcp
```

so the workstation runtime must be running locally. The plugin does **not** expose port `8765` to the Internet.

### 4. Try a safe first request

```text
Check my Remote Workstation health and list the workspaces I authorized.
```

Then try a workspace-scoped engineering task such as:

```text
Inspect my project, find the current build error, make the smallest safe fix, run tests, and show the Git diff.
```

See [Plugin installation](docs/PLUGIN_INSTALL.md) for troubleshooting, versioning, and ChatGPT web/public-directory limitations.

## Important: desktop/local plugin vs public ChatGPT web plugin

The v0.6 package is directly useful as a **local/repo marketplace plugin**. Its MCP endpoint is intentionally loopback-only. A web-hosted ChatGPT session cannot reach `127.0.0.1` on a user's workstation.

For a universal public-directory plugin that works from ChatGPT web, this project will need a remote HTTPS MCP path or an OpenAI-registered app mapping backed by a secure per-user tunnel/pairing service. The local MCP runtime and policy engine remain the workstation-side security authority; a future hosted layer must not replace them with an unrestricted public endpoint.

## Architecture

```text
ChatGPT Desktop     Codex      Claude      Cursor      Other MCP clients
       \              |          |           |               /
                         MCP / Plugin
                              |
                              v
                 +-------------------------+
                 | Remote Workstation MCP  |
                 +------------+------------+
                              |
                 +------------+------------+
                 | owner policy + leases   |
                 | audit + path protection |
                 +------------+------------+
                              |
             +----------------+----------------+
             |                |                |
        workspaces        local tools       SSH hosts
             |                |                |
         code/files        build/test       lab PCs
```

The plugin package provides discovery, install metadata, MCP wiring, and operating instructions. The existing MCP runtime remains the execution/security layer.

## Current capabilities

| Area | MCP tools |
| --- | --- |
| Discovery | `capabilities_list`, `system_info`, `tool_discover`, `update_check` |
| Workspaces | `workspace_list` |
| Files | `fs_list`, `fs_find`, `fs_search_text`, `fs_read`, `fs_write`, `fs_patch` |
| Git inspection | `git_status`, `git_diff` |
| Build/run | `task_list`, `task_run`, `process_start`, `process_read`, `process_read_since`, `process_list`, `process_stop` |
| SSH | `ssh_hosts`, `ssh_probe`, `ssh_exec` |
| Permission state | `permission_status` |
| Optional full user control | `host_fs_list`, `host_fs_read`, `host_fs_write`, `shell_exec` |

Root/Administrator control is **not** exposed by the normal v0.6 MCP process. It is reserved for a future isolated privileged helper.

## Security properties

- Safe default mode is workspace-scoped.
- Local policy is never writable through MCP.
- Workspace paths are canonicalized after symlink resolution.
- Normal process execution uses executable + argv with `shell: false` and an owner allowlist.
- Child-process environments are allowlisted and secret-like variable names are filtered.
- File writes support SHA-256 optimistic concurrency for multi-agent editing.
- SSH uses named owner-approved hosts, BatchMode authentication, strict host-key policy, forwarding disabled, and per-host executable allowlists.
- Full-control features require **both** an active time-limited local lease **and** explicit local policy gates.
- A full-control lease can be bound to a client profile ID.
- The AI cannot grant, extend, or revoke its own permission lease.
- Managed HTTP binds to `127.0.0.1` only.
- The managed Linux service uses `NoNewPrivileges=true`.
- Plugin packaging is validated in CI before release packaging.

### Important boundary

The workspace path guard protects the built-in filesystem tools. It is **not an OS sandbox for child processes**. A compiler, interpreter, build script, debugger, or raw shell you authorize runs with the operating-system permissions of the account running Remote Workstation MCP. Only allow tools and projects you trust.

## Requirements

- Linux/Ubuntu recommended for the managed workstation service
- Node.js 22+
- npm
- Git
- OpenSSH client for SSH tools
- ChatGPT desktop/Codex with Plugins support for the marketplace install path

The MCP core also supports stdio on other operating systems, while the managed `systemd --user` installer is Linux-oriented.

## Managed Linux installation

If you are using the MCP server without the plugin UI, the runtime can be installed directly:

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

Validate the installation:

```bash
npm run doctor
systemctl --user status remote-workstation-mcp.service
curl -fsS http://127.0.0.1:8765/healthz
```

## Local stdio clients

For local MCP clients, stdio remains available:

```bash
cp config/policy.example.yaml config/policy.yaml
npm install
npm run build
RWMCP_POLICY="$PWD/config/policy.yaml" \
RWMCP_CLIENT_ID=my-agent \
RWMCP_CLIENT_TYPE=mcp \
node "$PWD/dist/cli.js" --stdio
```

Use a distinct `RWMCP_CLIENT_ID` for dedicated client profiles when permission leases or audit records should be bound to a specific profile.

## Build/test task profiles

Edit the local `policy.yaml`:

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

The managed install creates an empty local host policy. Configure only hosts you explicitly authorize in:

```text
~/.config/remote-workstation-mcp/hosts.yaml
```

Example:

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

Full-control tools are disabled by default. To enable them, the owner must explicitly enable only the needed policy gates and create a short lease locally.

Example policy gates:

```yaml
fullControl:
  allowRawShell: true
  allowHostFilesystem: true
```

Managed HTTP client lease:

```bash
node ~/.local/share/remote-workstation-mcp/current/scripts/grant-permission.mjs \
  --mode full_control \
  --ttl 30m \
  --client-id local-http \
  --reason "interactive engineering session"
```

Check or revoke it:

```bash
node ~/.local/share/remote-workstation-mcp/current/scripts/grant-permission.mjs --status
node ~/.local/share/remote-workstation-mcp/current/scripts/grant-permission.mjs --revoke
```

The AI has no MCP tool that can create or extend its own lease.

## Updates and rollback

The managed installer creates a periodic update timer. Default mode is `notify`.

```text
off
auto_patch
auto
notify
```

Manual check/update:

```bash
node ~/.local/share/remote-workstation-mcp/current/scripts/update-user.mjs --check
node ~/.local/share/remote-workstation-mcp/current/scripts/update-user.mjs
```

Release packages are verified against `SHA256SUMS.txt`, installed into a new version slot, health checked after restart, and rolled back automatically on failure. The updater never treats an older GitHub release as an upgrade.

Manual rollback:

```bash
bash ~/.local/share/remote-workstation-mcp/current/scripts/rollback-user.sh
```

Marketplace snapshots can be refreshed separately:

```bash
codex plugin marketplace upgrade
```

The plugin package and workstation runtime are versioned separately at the distribution layer even when released from the same repository.

## Multi-agent editing

Read before writing and pass the returned `sha256` as `expectedSha256` to `fs_patch` or overwrite operations. If another agent changes the file first, the stale write is rejected instead of silently overwriting newer work.

Git worktree isolation for larger concurrent coding tasks remains a later milestone.

## Documentation

- [Plugin installation](docs/PLUGIN_INSTALL.md)
- [Architecture](docs/ARCHITECTURE.md)
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

CI validates source, tests, the portable/compatibility plugin manifests, local doctor behavior, and the packed production artifact before release publication.

## License

Apache-2.0
