# Multi-agent design

## Goal

Allow multiple MCP-compatible AI clients to use the same workstation control plane without coupling the core to ChatGPT, Codex, Claude, Cursor, or any other vendor.

## Two distinct problems

### Multi-client access

Several AI clients can independently connect to Remote Workstation MCP and invoke the same typed capabilities. This is supported now through standard MCP transports and dedicated client profiles.

### Agent-to-agent orchestration

One agent delegating work to another is a higher layer and is intentionally not part of the v0.5 core. A future task broker can coordinate agents while Remote Workstation MCP remains the execution/control plane and local policy boundary.

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

## Future worktree isolation

SHA-256 checks protect individual files but do not solve repository-level conflicts. Larger concurrent coding jobs should eventually use task-scoped Git worktrees:

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

Future orchestration may look like:

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
