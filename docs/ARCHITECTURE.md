# Architecture

Remote Workstation MCP is an **AI-vendor-neutral engineering control plane**. ChatGPT, Codex, Claude Code, Cursor, VS Code integrations, and custom MCP clients are clients of the same core; none is a privileged part of the domain architecture.

```text
AI / agent clients
      |
      | MCP (stdio or Streamable HTTP)
      v
+-----------------------------+
| MCP interface / tool schema |
+--------------+--------------+
               |
               v
+-----------------------------+
| local owner policy          |
| capability boundary         |
+--------------+--------------+
               |
               v
+-----------------------------+
| adapters                    |
| filesystem / git / process  |
+--------------+--------------+
               |
               v
         workstation OS
```

## Dependency direction

MCP handlers depend on domain/adapters. Adapters depend on local policy. The policy layer never depends on an AI vendor or prompt semantics.

## Multi-client rules

1. MCP compatibility is the interoperability contract; vendor-specific behavior belongs in optional integration documentation only.
2. File reads return SHA-256 values. Writers may supply `expectedSha256` so stale agents fail instead of silently overwriting newer work.
3. Audit records include client observability tags. In v0.2 those tags are not authentication identities and MUST NOT be used for authorization.
4. Future authenticated per-client policy will sit before capability execution; an agent will never grant itself a stronger role.
5. Concurrent coding work should eventually use isolated Git worktrees rather than several agents editing one tree.

## Remote access

Remote transport is separate from the MCP core. ChatGPT can use an OpenAI Secure MCP Tunnel; other clients may use stdio or another standards-compatible transport. No vendor transport is allowed to become the security authority.

## Future engineering adapters

SSH, Docker, serial/USB, OpenOCD/GDB/ST-Link, STM32/ESP32 and ROS 2 are adapters layered behind the same policy boundary.
