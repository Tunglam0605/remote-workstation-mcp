# Architecture

Remote Workstation MCP is an AI control plane, not a remote-desktop renderer and not a debugger implementation.

```text
ChatGPT / MCP client
        |
        v
MCP transport (stdio or loopback HTTP)
        |
        v
Tool registry
        |
        v
Owner policy
        |
        +---- PathGuard ---- Filesystem
        +---- Exec policy -- Process manager
        +---- Safe adapter - Git
        |
        v
Local workstation
```

## Boundaries

- MCP handlers never execute shell strings directly.
- Filesystem access is workspace-relative and canonicalized through `realpath`.
- Process execution uses `spawn(program, argv, { shell: false })` and a local executable allowlist.
- Child processes inherit an allowlisted environment only; obvious secret variable names are refused even when mistakenly configured.
- Audit records intentionally exclude file contents, command output and environment values.
- HTTP binds to loopback only in v0.1. Remote ChatGPT access is expected to use an outbound secure MCP tunnel.

## Extension path

Future adapters may expose SSH, serial, ROS 2, STM32, OpenOCD, GDB, Docker and vendor tools. Domain adapters sit behind the same policy and audit layers instead of bypassing them.
