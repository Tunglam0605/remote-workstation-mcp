# Remote Workstation MCP

**AI-vendor-neutral MCP control plane for engineering workstations.** It lets MCP-compatible AI clients inspect and edit approved code, run builds/tests, supervise processes, use installed development tools, and later access explicitly authorized remote machines — under local owner-controlled policy.

> **Alpha software.** It can modify files and execute programs. Start with a disposable workspace and least-privilege policy.

## Why this project

The goal is not a ChatGPT-only remote desktop. The goal is one secure workstation interface that can be used by ChatGPT, Codex, Claude Code, Cursor, VS Code integrations, and custom MCP agents without moving security policy into any AI vendor.

```text
ChatGPT   Codex   Claude   Cursor   Custom agents
    \       |       |       |       /
             MCP contract
                  |
                  v
        Remote Workstation MCP
                  |
        local owner policy
                  |
       files / git / process
                  |
             workstation
```

## Design goals

- **Safe by default, powerful when explicitly authorized.**
- **AI-vendor-neutral:** the MCP core does not privilege a specific model/client.
- Owner policy is local and cannot be changed through MCP tools.
- Filesystem access is workspace-scoped with symlink/traversal protection.
- Commands use executable + argv with `shell: false`; no raw shell by default.
- Child-process environment is minimized to reduce credential leakage.
- Long-running programs are managed as sessions with bounded output and timeout.
- File reads return SHA-256 values so concurrent agents can use optimistic concurrency.
- STM32, ROS 2, GDB, OpenOCD, Docker and vendor tools remain adapters behind the same policy boundary.

## v0.2 tools

| Tool | Purpose |
| --- | --- |
| `capabilities_list` | Discover available/planned workstation capabilities |
| `system_info` | Non-secret host information |
| `workspace_list` | Authorized workspaces |
| `fs_list` | List workspace directory |
| `fs_read` | Read UTF-8 file + SHA-256 |
| `fs_write` | Create/overwrite text file; optional SHA-256 precondition |
| `fs_patch` | Exact replacement; optional SHA-256 precondition |
| `git_status` | Read-only repository status |
| `git_diff` | Read-only diff |
| `process_start` | Start allowlisted executable without shell |
| `process_read` | Read process state/output |
| `process_list` | List managed processes |
| `process_stop` | Stop managed process |

## Requirements

- Node.js 22+
- npm
- Git for Git tools
- An MCP-compatible client

## Install

```bash
git clone https://github.com/Tunglam0605/remote-workstation-mcp.git
cd remote-workstation-mcp
npm install
cp config/policy.example.yaml config/policy.yaml
npm run typecheck
npm test
npm run build
```

Edit `config/policy.yaml` so each workspace root points only to directories the agent should access.

## Run

### Local stdio

```bash
npm run start:stdio
```

This is the preferred compatibility baseline for local MCP clients.

### Loopback Streamable HTTP

```bash
npm start
# MCP endpoint: http://127.0.0.1:8765/mcp
# Health:       http://127.0.0.1:8765/healthz
```

The HTTP listener intentionally binds to loopback.

## Optional per-client audit tags

If you run a dedicated MCP instance/profile for one client, you can label its audit events:

```bash
RWMCP_CLIENT_ID=codex-main RWMCP_CLIENT_TYPE=codex npm run start:stdio
```

These values are **observability metadata only in v0.2**. They are not authentication and never grant permissions.

## Multi-agent safe editing

Clients should read before modifying and pass the returned `sha256` as `expectedSha256` to `fs_patch` or overwrite operations. If another agent changed the file first, the write fails with a concurrency conflict instead of silently destroying the newer edit.

See [`docs/MULTI_AGENT.md`](docs/MULTI_AGENT.md).

## ChatGPT remote access

ChatGPT can use the same core through OpenAI Secure MCP Tunnel. Keep the workstation server private and run the tunnel client outbound from the workstation. This transport is optional and is not part of the core policy boundary.

## Security boundary

The model/client is **not** the security authority. Every request is revalidated locally by policy and adapters. Do not authorize based on a client name supplied by an AI connection.

The long-term goal includes owner-approved, time-limited elevation up to full administrative control, authenticated per-client roles, SSH, Git worktrees for concurrent agents, and engineering/debug adapters. These remain intentionally outside the default v0.2 privilege surface.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Multi-agent design](docs/MULTI_AGENT.md)
- [Security](docs/SECURITY.md)
- [Threat model](docs/THREAT_MODEL.md)
- [Roadmap](docs/ROADMAP.md)

## License

Apache-2.0
