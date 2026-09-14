# Threat model

The AI caller is treated as untrusted input. This includes hallucinated tool calls and prompt injection contained in source files, logs, build output, terminal output, remote SSH content, documentation and generated artifacts.

## Assets to protect

- owner files outside authorized workspaces
- credentials and environment secrets
- SSH keys and remote machines
- integrity of source repositories
- local policy/host/update configuration
- permission leases
- workstation availability
- release/update integrity
- audit trail

## Threats and current controls

| Threat | v0.5 control |
| --- | --- |
| `../` path traversal | workspace-relative validation + canonical path containment |
| Symlink escape | `realpath` containment checks before built-in filesystem access |
| Stale multi-agent overwrite | optional SHA-256 preconditions on writes/patches |
| Shell injection during normal execution | executable + argv, `shell: false` |
| Arbitrary normal process execution | owner executable allowlist |
| Secret leakage through inherited environment | environment allowlist + secret-like variable-name rejection |
| Runaway process | runtime timeout + managed process registry |
| Output flooding | bounded captured stdout/stderr + incremental cursors |
| Hidden policy changes | no MCP policy/host/lease mutation tools |
| Public MCP exposure | loopback-only HTTP; secure outbound transport recommended |
| Unauthorized SSH target | named host allowlist |
| SSH command expansion | per-host program allowlist + quoted argv construction |
| SSH credential disclosure | agent/local identity-file configuration; password auth not implemented |
| SSH forwarding/pivoting | forwarding disabled by adapter options |
| Silent software corruption | release SHA-256 verification + version slots + health rollback |
| AI self-elevation | permission grant/revoke exists only as local owner script |
| Full-control lease reuse by another profile | optional client-ID binding on full-control lease |
| Persistent accidental full control | time-limited lease expiration + explicit policy gates |
| Root compromise through normal service | managed service uses `NoNewPrivileges=true`; root/admin not exposed in v0.5 |

## Residual risks

### Authorized child processes are not sandboxed

A workspace restriction on built-in file tools does not confine an authorized compiler, interpreter, build script, debugger or raw shell. Such a process runs with the OS permissions of the service account.

Mitigation: keep executable allowlists narrow, use disposable workspaces for untrusted code, and add VM/container/namespace isolation for higher-risk workloads.

### Client audit tags are not authentication

`RWMCP_CLIENT_ID` and `RWMCP_CLIENT_TYPE` are useful for dedicated profiles and lease binding, but environment labels alone are not a cryptographic identity proof.

Mitigation: keep sensitive remote transports authenticated and add transport-authenticated principal mapping in a later release.

### Raw shell is intentionally dangerous

When explicitly enabled with a valid full-control lease, `shell_exec` can exercise whatever the service OS account can access. This is an owner-approved escape hatch, not a safe default.

Mitigation: short supervised leases, separate client profile IDs, rapid revoke, audit review and no root privilege in the normal service.

### Checksums are not artifact signing

SHA-256 verifies that a downloaded package matches the published checksum but does not independently prove publisher identity if the release channel itself is compromised.

Mitigation: future signed artifacts, provenance/SBOM and stronger release verification.

## Out of scope for v0.5

- hardened multi-user isolation
- automatic Git worktree isolation
- OS/container sandbox enforcement
- root/Administrator privilege brokering
- GUI desktop automation
- cryptographically authenticated per-client role mapping inside the core
- release artifact signing/provenance

These are roadmap items and must not be implied by current capability names.
