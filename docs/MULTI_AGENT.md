# Multi-agent design

## Goal

Allow multiple MCP-compatible AI clients to use the same workstation control plane without coupling the core to ChatGPT, Codex, Claude, Cursor, or any other vendor.

## Two distinct problems

### Multi-client access

Several AI clients can independently connect to Remote Workstation MCP and invoke the same typed capabilities. This is supported now through standard MCP transports and dedicated client profiles.

### Agent-to-agent orchestration

One agent delegating work to another remains a higher layer. The v0.17 foundation now provides only two safe prerequisites:

- Project Session Groups can coordinate multiple caller-owned Work Sessions that already belong to the same project.
- Worker Provider Registry can report optional provider descriptors/status without exposing dispatch or execution.

There is still no task broker or autonomous worker dispatch surface. Direct MCP control remains the primary path. A future broker may coordinate providers only by consuming existing Work Objective tasks and must route execution back through the deterministic scheduler, TaskExecutionCoordinator, typed workflow binding and local policy/resource boundaries.

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

SHA-256 checks protect individual files but do not solve repository-level conflicts. Writable Work Sessions now use session-owned sibling Git worktrees and isolated build directories; future delegated workers must reuse those same boundaries rather than inventing a second isolation model:

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
