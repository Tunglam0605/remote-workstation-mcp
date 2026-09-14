# Threat model

The AI caller is treated as untrusted input. This includes hallucinated tool calls and prompt injection contained in source files, logs, terminal output or remote content.

| Threat | v0.1 control |
| --- | --- |
| `../` path traversal | workspace-relative path validation |
| Symlink escape | canonical `realpath` containment checks |
| Shell injection | no shell; executable + argv only |
| Secret leakage through environment | environment allowlist + secret-name rejection |
| Reading arbitrary host files | explicit workspace roots only |
| Arbitrary process execution | executable allowlist |
| Runaway process | runtime timeout + managed process registry |
| Output flooding | bounded captured stdout/stderr |
| Hidden policy changes | no MCP policy-mutation tool |
| Internet exposure | loopback-only server; outbound tunnel recommended |

Out of scope for v0.1: multi-user isolation, remote SSH authorization, root privilege brokering, GUI automation and hardened container isolation.
