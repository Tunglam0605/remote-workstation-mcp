# Architecture

Remote Workstation MCP is an **AI-vendor-neutral engineering control plane**. ChatGPT Web, ChatGPT desktop, Codex, Claude Code, Cursor, VS Code integrations and custom MCP clients are peers of the same workstation interface; none is trusted merely because of vendor or model identity.

The primary architectural rule for v0.7+ is:

> **ChatGPT/GPT Web may directly operate the workstation through typed MCP tools. Codex, Claude and other coding agents are optional workers, not required middleware.**

```text
                         AI / agent clients
                    ChatGPT Web / local clients
                              |
                              | MCP
                              v
+-------------------------------------------------------------+
| Connection plane                                            |
| stdio | loopback HTTP | secure tunnel | remote HTTPS        |
+-----------------------------+-------------------------------+
                              |
                              v
+-------------------------------------------------------------+
| Authentication boundary                                     |
| principal | client/session identity | scopes/capabilities   |
+-----------------------------+-------------------------------+
                              |
                              v
+-------------------------------------------------------------+
| Local owner control plane                                   |
| policy + permission lease + approvals + audit + limits      |
+-----------------------------+-------------------------------+
                              |
          +-------------------+--------------------+
          |                   |                    |
          v                   v                    v
+-------------------+ +-------------------+ +-------------------+
| code/workspace    | | execution/build   | | remote/engineering|
| FS + search       | | process + tasks   | | SSH               |
| Git + worktrees   | | diagnostics       | | DAP/GDB/probes    |
| future LSP        | | future PTY        | | future ROS2       |
+---------+---------+ +---------+---------+ +---------+---------+
          |                     |                     |
          +---------------------+---------------------+
                                |
                                v
                         workstation / lab PCs

                    optional delegation only
                                |
                  Codex | Claude | OpenHands | custom
```

## Dependency direction

MCP handlers are a thin protocol layer. They call adapters/domain services. Adapters enforce local policy before touching the operating system. Policy, permission leases and host configuration do not depend on prompt wording or an AI vendor.

The core rule remains:

> **LLM output is untrusted input. Local owner policy is the authority.**

Transport and agent delegation are replaceable edges. They must not bypass the policy engine or become prerequisites for direct workstation tools.

## Capability layers

### 1. Safe workspace layer

Available after configuration:

- workspace discovery
- bounded file list/read/search/write/patch
- SHA-256 optimistic concurrency
- Git status/diff/history/branch inspection
- typed Git stage/commit/branch operations behind workspace write policy
- isolated Git worktree creation/removal for concurrent engineering sessions
- allowlisted process execution
- incremental process output
- owner-defined build/test task profiles
- structured build diagnostics for GCC/Clang/MSVC/CMake
- installed-tool discovery

### 2. Semantic engineering layer

The next v0.7 direct-control layer adds semantic code and persistent interactive execution without requiring a coding-agent worker:

- LSP definitions/references/symbols/hover/diagnostics
- rename preview and code actions
- persistent terminal/PTTY sessions with bounded cursors
- session ownership and conflict controls

The design preference is semantic/typed operations before raw shell or large source/log transfers.

### 3. Remote-machine layer

SSH uses named owner-approved host profiles. The adapter applies:

- BatchMode authentication
- strict/accept-new host-key policy
- forwarding disabled
- per-host executable allowlist
- bounded timeout/output
- optional remote root

Passwords are not part of the MCP protocol.

### 4. Temporary full-user-control layer

`host_fs_*` and `shell_exec` require both an explicit local policy gate and an active `full_control` lease. Lease creation/revocation is a local owner operation and is deliberately absent from MCP tools.

A lease may be bound to a dedicated client profile ID. Expiration automatically returns the service to the configured baseline mode.

Root/Administrator execution is not part of this layer. It requires a separately isolated privileged helper.

## Direct-control workflow

A normal engineering loop should be possible directly from ChatGPT/GPT Web:

```text
inspect workspace
  -> semantic/search read
  -> patch file
  -> stage/commit or create isolated worktree
  -> run owner-approved build/test task
  -> poll compact process state
  -> parse structured diagnostics
  -> read only the source ranges needed for a fix
  -> repeat
```

No Codex/Claude worker is required for this loop.

## Token-efficiency model

Large workstation data stays local until explicitly requested. Tools should prefer summaries plus bounded follow-up reads:

```text
compiler output -> local parser -> compact diagnostics -> model
process log     -> cursor       -> only new output      -> model
source tree     -> search/LSP   -> relevant locations   -> model
browser/debug   -> summaries    -> selected detail      -> model
```

This reduces tunnel round trips and context consumption without outsourcing the task to another coding agent.

## Git concurrency model

`repoPath` lets one authorized workspace be a common parent of a source checkout and sibling worktrees:

```text
Authorized workspace root/
├── project/            <- repoPath
├── task-a/             <- isolated worktree
└── task-b/             <- isolated worktree
```

`git_worktree_add` refuses destinations inside the source repository. This avoids nested worktrees becoming untracked content in the primary checkout and gives concurrent sessions an explicit filesystem boundary.

Concurrent file edits inside one worktree still use SHA-256 preconditions. Larger parallel jobs should use separate worktrees and merge/review handoff.

## Process/session model

Processes started by the agent receive UUID session IDs. Output is bounded in memory. `process_read_since` provides monotonic cursors so AI clients can poll only new stdout/stderr instead of repeatedly transferring the entire buffer.

`build_diagnostics` parses managed process buffers into bounded structured diagnostics instead of forcing the model to ingest full compiler output.

Persistent PTY sessions are a separate planned abstraction because interactive terminals have different lifecycle, input, resize and security semantics from one-shot managed processes.

## Transport model

Transport is a provider boundary, not part of workstation business logic:

```text
local client -> stdio/loopback --------------------+
OpenAI path  -> secure MCP tunnel -----------------+-> auth -> policy -> tools
other path   -> authenticated HTTPS/relay --------+
```

The built-in HTTP endpoint remains loopback-only by default. Public web connectivity must authenticate a principal before tool execution. A tunnel or relay transports requests; it does not grant workstation permissions by itself.

## Optional agent delegation

Agent workers sit above the workstation core:

```text
ChatGPT -> direct MCP tools -> workstation
    \
     \-> optional agent_task(provider=codex|claude|openhands|custom)
```

Delegated workers must receive bounded capabilities/worktrees and remain subject to the same owner policy. Their token quota, availability or authentication must never determine whether direct GPT control works.

## Update architecture

Managed Linux installs use version slots:

```text
~/.local/share/remote-workstation-mcp/
├── versions/<version>/
├── current  -> versions/<version>/
├── previous -> versions/<old>/
└── runtime/
```

The updater consumes GitHub Release artifacts, verifies SHA-256, installs to a new slot, atomically switches `current`, restarts, validates `/healthz`, and rolls back on failure. Scheduled auto-update is opt-in; default mode is notify.

## Engineering adapters

DAP, GDB/MI, STM32/ESP32, serial/USB, OpenOCD, ST-Link, J-Link, Docker, browser DevTools, Windows UI Automation and ROS 2 are typed adapters behind the same policy boundary.

Protocol preference is:

```text
typed API / LSP / DAP / GDB / vendor CLI
    > OS UI Automation
    > pixel/vision automation
```

Raw shell remains an explicitly elevated escape hatch, not the preferred API for routine engineering workflows.
