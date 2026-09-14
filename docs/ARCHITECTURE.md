# Architecture

Remote Workstation MCP is an **AI-vendor-neutral engineering control plane**. ChatGPT, Codex, Claude Code, Cursor, VS Code integrations and custom MCP clients are peers of the same workstation interface; none is trusted merely because of vendor or model identity.

```text
AI / agent clients
      |
      | MCP (stdio or Streamable HTTP)
      v
+------------------------------+
| MCP interface / tool schemas |
+---------------+--------------+
                |
                v
+------------------------------+
| local owner control plane    |
| policy + permission lease    |
| host/SSH allowlists + audit  |
+---------------+--------------+
                |
        +-------+---------+----------------+
        |                 |                |
        v                 v                v
+---------------+ +---------------+ +---------------+
| workspace     | | local runtime | | SSH adapter   |
| filesystem    | | process/tasks | | named hosts   |
| search / Git  | | tool discover | | allowlisted   |
+-------+-------+ +-------+-------+ +-------+-------+
        |                 |                |
        +-----------------+----------------+
                          |
                          v
                  workstation / lab PCs
```

## Dependency direction

MCP handlers are a thin protocol layer. They call adapters/domain services. Adapters enforce local policy before touching the operating system. Policy, permission leases and SSH host configuration do not depend on prompt wording or an AI vendor.

The core rule is:

> **LLM output is untrusted input. Local owner policy is the authority.**

## Capability layers

### 1. Safe workspace layer

Available by default after configuration:

- workspace discovery
- bounded file list/read/search/write/patch
- SHA-256 optimistic concurrency
- read-only Git status/diff
- allowlisted process execution
- incremental process output
- owner-defined build/test task profiles
- installed-tool discovery

### 2. Remote-machine layer

SSH uses named owner-approved host profiles. The adapter applies:

- BatchMode authentication
- strict/accept-new host-key policy
- forwarding disabled
- per-host executable allowlist
- bounded timeout/output
- optional remote root

Passwords are not part of the MCP protocol.

### 3. Temporary full-user-control layer

`host_fs_*` and `shell_exec` require both an explicit local policy gate and an active `full_control` lease. Lease creation/revocation is a local owner operation and is deliberately absent from MCP tools.

A lease may be bound to a dedicated client profile ID. Expiration automatically returns the service to the configured baseline mode.

Root/Administrator execution is not part of this layer. It requires a future separately isolated privileged helper.

## Process/session model

Processes started by the agent receive UUID session IDs. Output is bounded in memory. `process_read_since` provides monotonic cursors so AI clients can poll only new stdout/stderr instead of repeatedly transferring the entire buffer.

This supports workflows such as build servers, ROS nodes, test runners and debuggers without turning every operation into a blocking one-shot command.

## Update architecture

Managed Linux installs use version slots:

```text
~/.local/share/remote-workstation-mcp/
├── versions/0.5.0/
├── current  -> versions/0.5.0/
├── previous -> versions/<old>/
└── runtime/
```

The updater consumes GitHub Release artifacts, verifies SHA-256, installs to a new slot, atomically switches `current`, restarts, validates `/healthz`, and rolls back on failure. Scheduled auto-update is opt-in; default mode is notify.

## Multi-client rules

1. MCP is the interoperability contract; vendor-specific setup belongs in integration documentation.
2. Audit client tags are observability metadata unless a stronger authenticated transport establishes identity.
3. Full-control leases are locally issued and may be bound to a dedicated profile ID.
4. Concurrent file writers should use SHA-256 preconditions.
5. Larger concurrent coding jobs should use separate Git worktrees; worktree automation remains a later milestone.
6. Agent-to-agent delegation belongs above this workstation layer and must not weaken local policy.

## Remote access

The built-in HTTP endpoint is loopback-only. Local clients normally use stdio. Remote clients should use a standards-compatible secure outbound transport/tunnel. Transport authenticates/connects a client; it does not replace workstation policy.

## Engineering adapters

STM32/ESP32, serial/USB, OpenOCD, GDB, ST-Link, Docker and ROS 2 are intended as typed adapters behind the same policy boundary. Raw shell remains an explicitly elevated escape hatch, not the preferred API for routine engineering workflows.
