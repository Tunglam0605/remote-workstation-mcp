# Multi-agent design

## Goal

Allow multiple MCP-compatible AI clients to use the same workstation control plane without coupling the core to ChatGPT, Codex, Claude, Cursor, or any other vendor.

## Two distinct problems

### Multi-client access

Several AI clients can independently connect to Remote Workstation MCP and invoke the same typed capabilities. This is supported now through standard MCP transports and dedicated client profiles.

### Human-managed multi-chat workflow (v0.20 development)

The preferred ChatGPT Web scaling model is **multiple user-opened conversations**, each with its own explicit Work Session and isolated worktree when writable work is required.

RWMCP does not spawn ChatGPT conversations and does not decide which conversation should own engineering work. The human/controller chooses the split; RWMCP exposes deterministic state so those conversations do not silently collide.

Typical flow:

```text
Human
  +-- Chat A -> Work Session A -> Worktree A
  +-- Chat B -> Work Session B -> Worktree B
  +-- Chat C -> read/review session
                    |
                    v
             RWMCP coordination
```

Use:

1. `project_status(workspace, projectPath)` to inspect caller-owned sessions, current task labels, dirty worktrees, shared-worktree conflicts, stale/idle state and mechanical duplicate-task-label signals.
2. Explicitly choose an existing session or create a new one. RWMCP does not auto-select a session or task.
3. `work_session_resume(sessionId)` to receive the bounded Context Capsule, owned runtime state and same-project coordination snapshot in one read-only handoff call.
4. Use `work_session_checkpoint(..., currentTask: "...")` to publish the task label currently owned by that conversation. Use `currentTask: null` to release the label when finished.
5. Before closing or cleaning stale work, call `work_session_lifecycle_preview(sessionId)`. The preview reports only mechanical blockers and never stops resources, closes sessions or removes worktrees.

Duplicate task labels are an advisory overlap signal, not proof of a conflict. ChatGPT Web/human judgement decides whether two sessions should continue, coordinate, or change scope.

### Agent-to-agent orchestration

v0.19 provides **Controlled Worker Orchestration** without making provider identity an authority source:

- Project Session Groups coordinate caller-owned Work Sessions that already belong to the same project.
- Worker Provider Registry reports optional provider descriptors/status and may hold runtime-registered dispatch adapters.
- MCP cannot register providers. `worker_provider_list` remains read-only.
- a delegated task must already exist in a caller-owned Work Objective and persist a `worker-provider` binding containing only `providerId`;
- `work_objective_execute_task` remains the execution entry point and accepts identifiers only;
- Scheduler Awareness, TaskExecutionCoordinator, resource leases/node interlocks and durable Task Attempts remain mandatory.

Direct MCP control remains the primary independent path. If every provider is unavailable, normal typed MCP control continues to work; orchestration merely reports `waiting-provider` for affected delegated tasks.

### Optional local Codex worker

From v0.23, a local `codex-local` implementation worker is enabled only by the workstation owner through the loopback Control Center Execution Policy. Legacy `RWMCP_CODEX_WORKER_ENABLED` environment flags are intentionally ignored so a background/runtime environment cannot silently consume Codex quota. `RWMCP_CODEX_EXECUTABLE` may still point to an absolute Codex CLI path; otherwise RWMCP resolves `codex` from `PATH`.

This provider is intentionally narrow:

- the registry remains empty when owner-local Control Center enablement is off;
- Codex receives one already-selected Work Objective task, never authority to select the next task;
- an isolated Work Session Git worktree is mandatory;
- dispatch requests `workspace-write` sandboxing, approval policy `never`, ephemeral execution and no web search;
- the provider never pushes, merges, tags, releases, deploys or edits owner policy/security configuration by design;
- ChatGPT Web reviews the resulting Git evidence and remains responsible for accepting, rejecting or revising the change;
- if the installed Codex CLI cannot honor the requested write sandbox, the dispatch is reported as blocked rather than widening permissions;
- the Control Center owns the default RWMCP-only / Codex-only / Both policy and budgets; an explicitly allowed Work Session override cannot enable Codex globally or change owner budgets;
- provider quota/rate-limit failures can latch the effective policy to RWMCP-only with an auditable reason, while a per-Work-Session task budget affects only that Work Session.

## Concurrency today

Every `fs_read` returns a SHA-256. `fs_write` and `fs_patch` accept `expectedSha256`. Clients should use it whenever modifying a file they previously read.

A mismatch means:

```text
another actor changed the file
        -> re-read
        -> review current state
        -> recompute patch
```

It must not be treated as permission to force-overwrite newer work.

For long-running processes, `process_read_since` lets each client maintain its own output cursors rather than repeatedly consuming the entire captured stream.

## Client profiles and audit

Dedicated integrations should use distinct profile labels:

```text
chatgpt-main
codex-main
claude-main
cursor-main
```

with:

```text
RWMCP_CLIENT_ID=<profile-id>
RWMCP_CLIENT_TYPE=<client-family>
```

Audit records include these labels.

These labels are **not cryptographic authentication**. They become useful security context only when the local owner controls the process profile and/or a trusted transport maps an authenticated client to that profile.

## Full-control sessions

A v0.5 full-control lease may be bound to one client profile ID. This reduces accidental sharing of an elevated session between dedicated profiles.

Recommended practice:

1. never issue one broad full-control lease for several agents at once;
2. use short TTLs;
3. bind the lease to the intended dedicated profile;
4. revoke after the task;
5. review audit records;
6. keep raw shell disabled unless the workflow actually needs it.

## Worktree isolation today

SHA-256 checks protect individual files but do not solve repository-level conflicts. Writable Work Sessions use session-owned sibling Git worktrees and isolated build directories; worktree-bound v0.19 providers must reuse those same boundaries rather than inventing a second isolation model:

```text
repository/
  main/
  worktrees/
    codex-task-001/
    claude-review-002/
    gpt-fix-003/
```

Target flow:

```text
request
  -> create isolated worktree
  -> assign one agent/session
  -> edit/build/test
  -> produce diff/commit
  -> review
  -> merge or discard
```

## Future authenticated authorization

The target policy model can evolve toward authenticated principals and roles, for example:

```yaml
clients:
  coding-agent:
    role: developer
    permissions:
      - filesystem.read
      - filesystem.write
      - process.execute
      - git.read

  reviewer-agent:
    role: reviewer
    permissions:
      - filesystem.read
      - git.read
```

This is a roadmap contract, not part of the v0.5 policy parser. Authorization must be based on a trusted identity source, not a name supplied by the model.

## Agent orchestration boundary

Controlled orchestration may look like:

```text
Owner / lead agent
        |
        +--> Codex coding task
        +--> Claude review task
        +--> another specialist agent
                    |
                    v
          Remote Workstation MCP
```

The orchestrator may decide who should do work, but every workstation action is still constrained by local policy. Delegation must never imply permission escalation.
