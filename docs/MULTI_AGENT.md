# Multi-agent design

## Goal

Allow multiple MCP-compatible AI clients to use the same workstation control plane without coupling the core to ChatGPT, Codex, Claude, Cursor, or any other vendor.

## Two distinct problems

### Multi-client access

Several AI clients can independently connect to the MCP server and invoke the same typed capabilities. This is the current direction.

### Agent-to-agent orchestration

One agent delegating work to another is a higher layer and is intentionally not part of the v0.2 core. A future task broker can coordinate agents while the workstation MCP remains the execution/control plane.

## Concurrency

Every `fs_read` returns a SHA-256. `fs_write` and `fs_patch` accept `expectedSha256`. Clients should use it whenever modifying a file they previously read. A mismatch is a conflict, not permission to overwrite.

Future releases will add task-scoped Git worktrees:

```text
repository/
  main/
  worktrees/
    codex-task-001/
    claude-review-002/
    gpt-fix-003/
```

## Identity and authorization

`RWMCP_CLIENT_ID` and `RWMCP_CLIENT_TYPE` currently add useful audit tags for deployments that run a dedicated MCP instance/profile per client. They are self-configured local metadata, not proof of identity.

Authenticated per-client authorization will require a trusted transport/authentication boundary and local owner policy. Until then, do not grant permissions based on client-supplied names.

## Target policy model

```yaml
clients:
  coding-agent:
    role: developer
    permissions: [filesystem.read, filesystem.write, process.execute, git.read]
  reviewer-agent:
    role: reviewer
    permissions: [filesystem.read, git.read]
```

This is a roadmap contract, not yet accepted by the v0.2 policy parser.
