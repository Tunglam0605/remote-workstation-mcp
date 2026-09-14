# Remote Workstation MCP

**AI-vendor-neutral MCP control plane for engineering workstations.**

Remote Workstation MCP lets MCP-compatible AI clients inspect and edit code, search workspaces, run builds/tests, supervise long-running processes, discover installed tools, execute approved SSH commands on remote machines, and—only when the owner explicitly enables it—temporarily gain full user-level shell/filesystem control.

> **v0.5 is security-sensitive beta software.** Start with a disposable workspace. Keep the default full-control gates disabled until you have validated your local policy.

## Mission

The project is not a ChatGPT-only remote desktop. It provides one local policy boundary for multiple AI clients such as ChatGPT, Codex, Claude Code, Cursor, VS Code integrations, and custom MCP agents.

```text
ChatGPT      Codex      Claude      Cursor      Custom agents
    \          |          |           |             /
                         MCP
                          |
                          v
              +-----------------------+
              | Remote Workstation MCP|
              +-----------+-----------+
                          |
              +-----------+-----------+
              | local owner policy    |
              | permission lease      |
              | audit                 |
              +-----------+-----------+
                          |
          +---------------+----------------+
          |               |                |
      workspaces       local tools      SSH hosts
          |               |                |
      code/files       build/debug       lab PCs
```

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

Root/Administrator control is **not** exposed in v0.5. It is reserved for a future isolated privileged helper rather than weakening the normal MCP process.

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
- HTTP binds to `127.0.0.1` only.
- The managed Linux service uses `NoNewPrivileges=true`.

### Important boundary

The workspace path guard protects the built-in filesystem tools. It is **not an OS sandbox for child processes**. A compiler, interpreter, build script, debugger, or raw shell you authorize runs with the operating-system permissions of the account running Remote Workstation MCP. Only allow tools and projects you trust. A stronger optional OS/container sandbox is planned.

## Requirements

- Linux/Ubuntu recommended for the managed service
- Node.js 22+
- npm
- Git
- OpenSSH client for SSH tools
- An MCP-compatible AI client

The MCP core also supports stdio on other operating systems, but the managed `systemd --user` installer is currently Linux-oriented.

## Quick start — managed Linux install

```bash
git clone https://github.com/Tunglam0605/remote-workstation-mcp.git
cd remote-workstation-mcp
npm run install:user
```

The installer runs typecheck/tests/build before installing and creates:

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

Check it:

```bash
curl http://127.0.0.1:8765/healthz
systemctl --user status remote-workstation-mcp.service
```

## Local stdio clients

For local MCP clients, stdio is the compatibility baseline:

```bash
cp config/policy.example.yaml config/policy.yaml
npm install
npm run build
RWMCP_POLICY="$PWD/config/policy.yaml" \
RWMCP_CLIENT_ID=my-agent \
RWMCP_CLIENT_TYPE=mcp \
node "$PWD/dist/cli.js" --stdio
```

Use a distinct `RWMCP_CLIENT_ID` for dedicated client profiles when you want permission leases/audit records bound to that profile.

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

The task program must still be present in `process.allowExecutables`.

## SSH remote machines

The managed install creates an empty local host policy. Copy ideas from `config/hosts.example.yaml` into:

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

Prefer `ssh-agent`. If an identity file is configured, the path remains local and is never returned through MCP. Password authentication is intentionally not implemented.

## Temporary full user-level control

Full-control tools are disabled by default. To enable them, the owner must do both steps locally.

### 1. Enable only the gates you need

Edit:

```text
~/.config/remote-workstation-mcp/policy.yaml
```

For example:

```yaml
fullControl:
  allowRawShell: true
  allowHostFilesystem: true
```

### 2. Grant a short client-bound lease

The managed HTTP service uses client profile ID `local-http`:

```bash
node ~/.local/share/remote-workstation-mcp/current/scripts/grant-permission.mjs \
  --mode full_control \
  --ttl 30m \
  --client-id local-http \
  --reason "interactive engineering session"
```

Check/revoke:

```bash
npm run permission:status
npm run permission:revoke
```

Or directly from the installed version:

```bash
node ~/.local/share/remote-workstation-mcp/current/scripts/grant-permission.mjs --status
node ~/.local/share/remote-workstation-mcp/current/scripts/grant-permission.mjs --revoke
```

The lease expires automatically. `permission_status` is read-only; no MCP tool can grant or extend a lease.

**Raw shell means the AI can do anything the local OS account can do.** Enable it only for an active supervised session.

## Updates and rollback

The managed installer creates a periodic update timer. Default mode is `notify`, so it does not silently replace the software.

Configure:

```text
~/.config/remote-workstation-mcp/update.env
```

Modes:

```text
off
notify
auto_patch
auto
```

Manual check/update:

```bash
node ~/.local/share/remote-workstation-mcp/current/scripts/update-user.mjs --check
node ~/.local/share/remote-workstation-mcp/current/scripts/update-user.mjs
```

Release packages are verified against `SHA256SUMS.txt`, installed into a new version slot, health checked after restart, and rolled back automatically on failure.

Manual rollback:

```bash
bash ~/.local/share/remote-workstation-mcp/current/scripts/rollback-user.sh
```

## ChatGPT remote access

ChatGPT cannot use a workstation-only loopback MCP endpoint directly over the Internet. Where supported, use OpenAI Secure MCP Tunnel so the workstation makes an outbound connection and the MCP server remains private. The tunnel is transport only; local policy remains the security authority.

See [`docs/CLIENTS.md`](docs/CLIENTS.md) for client integration notes.

## Multi-agent editing

Read before writing and pass the returned `sha256` as `expectedSha256` to `fs_patch` or overwrite operations. If another agent changes the file first, the stale write is rejected instead of silently overwriting newer work.

For larger concurrent coding tasks, Git worktree isolation is the next milestone.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Client integrations](docs/CLIENTS.md)
- [Operations](docs/OPERATIONS.md)
- [Multi-agent design](docs/MULTI_AGENT.md)
- [Security](docs/SECURITY.md)
- [Threat model](docs/THREAT_MODEL.md)
- [Roadmap](docs/ROADMAP.md)

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

CI runs the same validation on every push/PR. Tagged releases run the checks again, verify the tag matches `package.json`, build an npm tarball, generate SHA-256 checksums, and publish GitHub Release assets.

## License

Apache-2.0
