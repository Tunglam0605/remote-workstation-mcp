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
- owner access mode and legacy permission leases
- pending Administrator approval records
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
| Tunnel reachability confused with authorization | bearer-authenticated loopback MCP + request principal/scopes + local policy/mode/audit |
| OpenAI runtime key leaking into MCP process | runtime key stripped from MCP child environment |
| Runtime key written to repository/config JSON | optional Windows persistence uses current-user DPAPI in a separate user-profile secret blob |
| Local setup UI reached from LAN | Setup Console binds only to 127.0.0.1 and rejects non-loopback sockets |
| Browser CSRF against setup UI | ephemeral in-memory CSRF token embedded only in local page + same-origin check + custom token header + no-store responses |
| Setup convenience silently weakening policy | main UI exposes only explicit Read only / Workspace / Full access modes; Full access is visibly selected and still user-level only; technical setup stays collapsed |
| Unauthorized SSH target | named host allowlist |
| SSH command expansion | per-host program allowlist + quoted argv construction |
| SSH credential disclosure | agent/local identity-file configuration; password auth not implemented |
| SSH forwarding/pivoting | forwarding disabled by adapter options |
| Silent software corruption | release SHA-256 verification + version slots + health rollback |
| AI self-elevation | AI may create only an expiring `admin_request`; approval is not an MCP tool and elevated execution requires local Control Center approval; elevation then uses Windows RunAs/UAC under the machine policy |
| Legacy full-control lease reuse by another profile | authenticated principal/client binding on legacy leases |
| Persistent accidental Full access | explicit owner-selected mode, visible mode state, one-click downgrade to Workspace/Read only; legacy temporary leases still expire |
| Root compromise through normal service | normal MCP/Control Center stay non-elevated; local owner approval is mandatory, the one-shot Windows helper verifies the exact approved request hash, and RunAs/UAC performs elevation according to OS policy; Linux managed service uses `NoNewPrivileges=true` |

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

When the local owner selects Full access (or temporarily enables a compatible legacy lease), `shell_exec` can exercise whatever the service OS account can access. This is an owner-controlled user-level escape hatch, not Administrator access.

Mitigation: keep Workspace as the default on less-trusted machines, make Full access visibly selected, support one-click downgrade, review audit output, and keep Administrator privilege behind the separate UAC approval flow.

### Checksums are not artifact signing

SHA-256 verifies that a downloaded package matches the published checksum but does not independently prove publisher identity if the release channel itself is compromised.

Mitigation: future signed artifacts, provenance/SBOM and stronger release verification.

## Current residual boundaries and future hardening

The current control plane intentionally does **not** claim:

- OS/container sandbox enforcement for arbitrary owner-approved child processes;
- unrestricted privileged shell or persistent Administrator/root mode;
- generic Linux sudo/root brokering;
- GUI desktop automation as a default control primitive;
- public directory approval/entitlement control inside ChatGPT;
- independent release publisher signing/provenance;
- durable multi-user / Multi-Session isolation until the v0.15 Work Session ownership model is implemented.

Typed debug/probe/serial/ROS2 engineering adapters are now in scope and remain constrained by local policy, leases and provider-specific validation.

The available Administrator capability remains deliberately narrow: one locally approved direct Windows `.exe`/`.com` request at a time, with UAC. Broader privileged contracts remain future hardening work.
