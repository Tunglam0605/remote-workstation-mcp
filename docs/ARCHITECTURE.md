# Architecture

> Product direction is defined by [`PROJECT_CHARTER.md`](PROJECT_CHARTER.md). This document explains **how** that charter is implemented. If an architectural shortcut conflicts with the charter, the charter takes precedence until it is deliberately amended.

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

## Work Session execution plane

v0.15 adds a durable application-level identity above transport connections:

```text
authenticated principal
        |
        +-- Work Session A -> ExecutionContext -> ResourceOwner(principal, session)
        +-- Work Session B -> ExecutionContext -> ResourceOwner(principal, session)
        +-- implicit session -> backward-compatible callers that omit workSessionId
```

A browser tab, MCP connection or reconnect is not a Work Session. `workSessionId` is also not a bearer credential. Every session-aware operation first remains subject to authenticated principal scopes and local owner policy, then uses the Work Session only to constrain ownership and concurrency.

`WorkSessionStore` persists compact Context Capsules outside repositories. Capsules contain bounded project identity, objective, validated facts, selected provider/toolchain/variant, last successful acceptance, blockers, engineering decisions and pending actions. They intentionally exclude secrets, full transcripts, large raw logs and duplicated source.

Resource ownership is composite for process, PTY, serial, debug, engineering leases and durable workflow runs. Two requests from the same `openai-tunnel` principal but different Work Sessions cannot read, write, stop or release one another's private resources.

Writable Git sessions use an isolated branch/worktree/build-directory boundary. A dirty worktree is never force-removed by session cleanup. If the authorized workspace root is too narrow to contain a safe sibling worktree, creation fails closed instead of widening local filesystem authority.

Concurrency is classified rather than globally serialized:

- shared: filesystem/Git/project/provider reads;
- session-isolated: source edits, worktrees and isolated build directories;
- resource-exclusive: serial, probes, CAN adapters and mutable camera configuration;
- project/variant-exclusive: shared-output builds such as Keil;
- node-exclusive: runtime update/restart/reboot and major node configuration;
- owner-local-only: policy, permission and security-grant mutation.

Workflow-run metadata is durably attributed to principal + Work Session. On runtime restart, any record left `running` is reconciled to a bounded failed state rather than resurrected as fake live work.

## Selective Quality Learning plane

v0.16 adds a deterministic Selective Quality Learning plane above durable workflow attribution. It does **not** train a custom model, infer trust from repetition or automatically activate learned behavior.

```text
engineering_workflow_run
        |
        v
  WorkflowRunRecord
        |
        +--> deterministic outcome evidence
        +--> explicit Work Session identity
        +--> bounded compatibility metadata
        |
        v
 QualityObservation
        |
        +-- failed / blocked / ambiguous / implicit / restart -> ineligible
        |
        +-- explicit typed success ---------------------------> pending-owner-review
                                                                  |
                                                                  v
                                                        owner-local decision
                                                                  |
                                                      approved evidence set
                                                                  |
                                                                  v
                                                        ReusableKnowledge
                                                                  |
                                             metrics + canonical comparison
                                                                  |
                                                    shadow evaluation
                                                                  |
                                           owner-local promotion/revocation
                                                                  |
                                                     recommendation only
```

`QualityObservationStore` persists bounded observations outside repositories. Collection is owner-configurable through `QualityLearningSettingsStore`: learning can be disabled without affecting workflow execution, observation retention is time-bounded, record count is bounded, and the owner can clear learning history without modifying canonical project data such as `.rwmcp/project.yaml`.

`OwnerQualityReviewStore` keeps observation evidence immutable and writes a separate append-only decision history (`approved`, `rejected`, `revoked`) bound to the exact observation digest. Review remains loopback Control Center only. Approval is evidence consent, not execution authority.

`QualityKnowledgeStore` aggregates only approved, quality-gated typed-workflow evidence. Its metrics include sample count, approved sample count, success/failure/blocked rate, duration consistency, typed-completion ratio, environment diversity, recency, reproducibility and safety penalties. Repetition alone does not raise trust: unapproved samples do not count toward promotion evidence, failed or unsafe history lowers quality, and a configurable minimum evidence count plus score gate must pass.

Canonical comparison is explicit. When a typed canonical workflow already exists, learned knowledge may only improve confidence/recommendation around that workflow. A manual or raw-shell sequence competing with an available typed workflow is classified as an anti-pattern and the canonical workflow is preferred instead of learning a duplicate execution recipe.

Before promotion, a candidate enters shadow evaluation. A candidate with too little evidence remains `needs-more-evidence`; a material environment mismatch becomes `needs-revalidation`; a failing evidence gate remains failed. Promotion is append-only/versioned and creates `proven-learned` recommendation knowledge while preserving prior draft/shadow records. Promoted knowledge is always `recommendationOnly=true` and `executionActive=false`. A material environment change moves the latest recommendation back to shadow revalidation rather than silently trusting stale evidence.

Environment fingerprints contain bounded non-secret compatibility inputs. The core includes OS platform, CPU architecture, Node major, RWMCP server version, Action Schema version and Engineering API version. When available from the typed workflow, it also includes a hashed project identity, workflow, variant, hashed probe/hardware identity, provider/provider version and toolchain/toolchain version. Hostname, IP addresses, raw serial identifiers, user identity, tokens, API keys, source payloads and raw logs are excluded.

All owner learning controls are exposed only through the loopback Setup & Control Center with its peer/origin/ephemeral-token boundary: settings, review, draft creation, shadow evaluation, promotion, environment revalidation, revocation and history clearing. None are MCP tools.

Quality telemetry remains advisory. Failure to persist an observation must not change the engineering workflow result, and startup reconciliation must not fail the control plane if telemetry persistence is unavailable. Interrupted durable workflow records reconcile to failed state first; telemetry derived from restart reconciliation is explicitly ineligible.

The security boundary remains unchanged:

- observation, knowledge or Work Session identity is not an authorization credential;
- no MCP action can approve, promote, revoke, activate or clear learning state;
- owner/security policy, scopes, Full Access and cross-node grants cannot be widened by learning state;
- promotion cannot auto-push Git, mutate firmware, restart the runtime or create cross-node authority;
- promoted knowledge is recommendation-only and never an execution default by itself;
- frequency/repetition is not evidence of quality.

## Work Objective orchestration plane

Phase 3 introduces a persistent task graph above Work Sessions. It is deliberately a coordination layer, not a new authority layer.

```text
authenticated principal + local owner policy
                    |
                    v
              Work Session
                    |
                    v
              Work Objective
                    |
             persistent DAG
            /       |       \
         Task A   Task B   Task C
            \       |       /
                    v
        DeterministicTaskScheduler
                    |
          concurrency classification
                    |
        +-----------+-----------+
        |                       |
        v                       v
 EngineeringResourceManager  NodeInterlockStore
        |                       |
        +-----------+-----------+
                    |
                    v
        TaskExecutionCoordinator
                    |
                    v
             typed callback only
```

A Work Objective and Work Task are state identifiers only. They do not authenticate a caller, grant scopes, widen workspace access, issue cross-node authority or override local owner policy. Every objective is bound to the explicit `principalId + workSessionId` resource owner. The implicit backward-compatible Work Session is rejected for orchestration state.

The persistent DAG is bounded and validated on every structural mutation. Dependencies must reference tasks in the same objective, duplicate dependencies are rejected, self-dependencies are rejected and graph cycles fail closed. READY ordering is deterministic by priority, insertion sequence and stable task id.

Task lifecycle is explicit. Structural MCP tools may create tasks or replace dependencies but cannot mark execution as running/succeeded/failed. Runtime execution state belongs to the executor. On process restart, any stale `running` task is reconciled to failed state and dependency blocking is recomputed transitively instead of pretending work survived.

The scheduler is planning-only. A READY item without a declared `ConcurrencyOperation` is not dispatchable. Owner-local-only operations are never dispatchable through the orchestration executor. Operations whose concurrency class requires a key remain blocked until an explicit key is supplied.

The executor reuses existing authority primitives. Shared work needs no extra lease. Session-isolated, resource-exclusive and project/variant-exclusive work takes an `EngineeringResourceManager` lease. Node-exclusive work additionally takes the existing lifecycle `NodeInterlockStore` record so update/restart/rollback paths see active orchestration work. A busy lease fails before task state changes from READY to RUNNING.

No autonomous agent provider is part of this foundation. Future optional workers must enter through the same scheduler/executor boundary and cannot bypass Work Session ownership, resource leases, node interlocks, workspace policy or cross-node authorization.

## Control plane vs data plane

The normal MCP connection is a **control plane**. Commands, plans, compact status and bounded results travel through it. Large cross-node payloads should not be relayed through the model when the owner has an approved direct path.

v0.14 adds a generic core `DataPlaneAdapter`; v0.14.1 makes direct transport multi-endpoint instead of assuming every Tailscale address is mutually reachable. v0.14.2 adds a bounded control-plane relay fallback for the case where independent Direct Nodes are each reachable from ChatGPT but have no mutual peer route:

```text
AI client
   |
   | MCP control plane
   v
Direct Node A                    Direct Node B
     |                                |
     +==== approved direct data plane ====+
       Tailscale peer path or private LAN
                  file bytes only
```

The normal MCP runtime remains loopback-only. A receive offer creates separate short-lived one-shot listeners only on approved direct IPv4 candidates (Tailscale and filtered RFC1918 private LAN), under one exact SHA-256/size contract and ephemeral bearer ticket. Network-unreachable endpoints may be retried; authenticated receiver rejections remain fail-closed.

When no direct peer route exists, the fallback path uses the already-authenticated MCP control connections in bounded 64 KiB chunks. Relay state is persistent/resumable, each chunk carries its own SHA-256 and exact offset, and final acceptance still re-hashes the complete file before atomic promotion. Relay is deliberately capped at 32 MiB and remains secondary to the direct data plane.

v0.14.3 places a bilateral authorization boundary above both direct and relay transports. Cross-node data is default-deny. The source and destination each evaluate the same directional owner grant against stable node identity, source/destination workspace, path boundaries, file extension, size and transport. Only the configured authenticated OpenAI Secure MCP Tunnel principal with the dedicated cross-node scope may exercise a grant. A node cannot use this mechanism to issue commands to a peer or pull arbitrary peer data.

Legacy SSH/device execution is a separate recovery surface and is locally disabled by default. Full Access on one node does not imply authority over another node.

The data plane belongs to the core platform. Firmware/STM32, ROS 2, vision and other extensions may consume it but must not own or redefine it.

See [DATA_PLANE.md](DATA_PLANE.md).

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

Processes started by the controller receive UUID session IDs. Output is bounded in memory. `process_read_since` provides monotonic cursors so AI clients can poll only new stdout/stderr instead of repeatedly transferring the entire buffer.

v0.14.4 centralizes descendant cleanup through `ProcessTreeSupervisor`. POSIX managed processes run in a dedicated process group and terminate with TERM -> bounded grace -> KILL. Windows uses tree-aware termination and a forced fallback. Explicit stop and timeout share the same cleanup path so provider adapters do not implement ad-hoc kill logic.

`build_diagnostics` parses managed process buffers into bounded structured diagnostics instead of forcing the model to ingest full compiler output.

Interactive PTY/ConPTY sessions remain a separate lifecycle abstraction. Native `node-pty` is isolated in a per-terminal worker subprocess. The MCP host communicates with that worker through bounded typed IPC; PTY output is still bounded in the parent. A native ConPTY crash/leak therefore terminates the worker rather than the control plane, and worker exit gives the OS a hard cleanup boundary for native handles.

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
