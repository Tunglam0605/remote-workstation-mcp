# Threat model

The AI caller is treated as untrusted input. This includes hallucinated tool calls and prompt injection contained in source files, logs, build output, terminal output, remote SSH content, documentation, language-server responses and generated artifacts.

## Assets to protect

- owner files outside authorized workspaces
- credentials and environment secrets
- OpenAI tunnel runtime credentials
- SSH keys and remote machines
- integrity of source repositories
- local policy/host/update configuration
- persisted workstation setup state
- permission leases
- authenticated principal/scope integrity
- workstation availability
- release/update integrity
- audit trail

## Threats and current controls

| Threat | Current control |
| --- | --- |
| `../` path traversal | workspace-relative validation + canonical path containment |
| Symlink/reparse escape | `realpath` containment checks before built-in filesystem access |
| Stale multi-agent overwrite | optional SHA-256 preconditions on writes/patches; Git worktrees for larger parallel tasks |
| Shell injection during normal execution | executable + argv, `shell: false` |
| Arbitrary normal process execution | owner executable allowlist |
| Secret leakage through inherited environment | environment allowlist + secret-like variable-name rejection |
| Runaway process | runtime timeout + managed process registry |
| Output flooding | bounded captured stdout/stderr + incremental cursors |
| Hidden policy changes by AI | no MCP policy/host/lease mutation tools |
| Public MCP exposure | loopback-only HTTP; outbound Secure MCP Tunnel for cloud reachability |
| Tunnel reachability confused with authorization | bearer-authenticated loopback MCP + request principal/scopes + local policy/lease/audit |
| OpenAI runtime key leaking into MCP process | runtime key stripped from MCP child environment |
| Runtime key written to repository/config JSON | optional Windows persistence uses current-user DPAPI in a separate user-profile secret blob |
| Local setup UI reached from LAN | Setup Console binds only to 127.0.0.1 and rejects non-loopback sockets |
| Browser CSRF against setup UI | ephemeral in-memory CSRF token embedded only in local page + same-origin check + custom token header + no-store responses |
| Setup convenience silently weakening policy | existing owner config is preserved; dangerous scope/gate changes are explicit, warning-styled, still require the existing three-layer authorization model, and full-control leases are short-lived/client-bound |
| Unauthorized SSH target | named host allowlist |
| SSH command expansion | per-host program allowlist + quoted argv construction |
| SSH credential disclosure | agent/local identity-file configuration; password auth not implemented |
| SSH forwarding/pivoting | forwarding disabled by adapter options |
| Silent software corruption | release SHA-256 verification + version slots + health rollback |
| AI self-elevation | permission grant/revoke exists only as local owner operation |
| Full-control lease reuse by another profile | authenticated principal/client binding on leases |
| Persistent accidental full control | time-limited lease expiration + explicit policy gates |
| Root compromise through normal service | root/Administrator not exposed by the normal MCP process; Linux managed service uses `NoNewPrivileges=true` |

## Residual risks

### Authorized child processes are not sandboxed

A workspace restriction on built-in file tools does not confine an authorized compiler, interpreter, build script, debugger or raw shell. Such a process runs with the OS permissions of the service account.

Mitigation: keep executable allowlists narrow, use disposable workspaces for untrusted code, and add VM/container/namespace isolation for higher-risk workloads.

### Setup Console trusts the local owner session

The setup UI protects against network exposure and browser-origin attacks, but malware already running as the same OS user can generally inspect or alter that user's local files/processes and is outside the security boundary of this self-hosted agent.

Mitigation: run setup only on trusted workstations, stop the Setup Console after onboarding, protect the OS account, and use endpoint security appropriate to the workstation.

### Windows DPAPI is user-context protection, not malware isolation

The encrypted OpenAI runtime-key blob is protected for the current Windows user. A process already running as that same user may be able to request decryption.

Mitigation: keep the runtime key restricted to Tunnels Read + Use, rotate/revoke it when compromise is suspected, and avoid granting unrelated API permissions.

### Raw shell is intentionally dangerous

When explicitly enabled with a valid full-control lease and scope, `shell_exec` can exercise whatever the service OS account can access. This is an owner-approved escape hatch, not a safe default.

Mitigation: short supervised leases, principal binding, rapid revoke, audit review and no Administrator privilege in the normal service.

### Checksums are not artifact signing

SHA-256 verifies that a downloaded package matches the published checksum but does not independently prove publisher identity if the release channel itself is compromised.

Mitigation: future signed artifacts, provenance/SBOM and stronger release verification.

## Out of scope for v0.7.2

- hardened multi-user isolation
- OS/container sandbox enforcement
- root/Administrator privilege brokering
- GUI desktop automation
- public directory approval/entitlement control inside ChatGPT
- release artifact signing/provenance
- DAP/GDB/probe/serial/ROS2 engineering-debug adapters (planned for v0.8)

These remain roadmap items and must not be implied by current capability names.
