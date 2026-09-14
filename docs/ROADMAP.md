# Roadmap

## v0.1 — Local foundation ✅

- MCP server using the official TypeScript SDK v2
- stdio + loopback Streamable HTTP
- workspace filesystem tools
- read-only Git inspection
- managed allowlisted process execution
- audit log and security regression tests

## v0.2 — Vendor-neutral / multi-client foundation ✅

- AI-vendor-neutral core terminology
- capability discovery through `capabilities_list`
- client audit tags for dedicated profiles
- optimistic file concurrency with SHA-256 preconditions
- multi-agent architecture documentation and regression tests

## v0.3 — Workstation UX + managed distribution ✅

- executable/tool discovery
- bounded file/name/text search
- incremental process output cursors
- owner-defined build/test task profiles
- managed Linux user installation
- version slots, health checks and rollback
- GitHub Release package/checksum pipeline
- scheduled update checks with opt-in auto-update modes

## v0.4 — SSH remote machines ✅

- named owner-approved hosts
- `ssh-agent` or local identity-file authentication
- BatchMode and host-key checking
- forwarding disabled
- per-host executable allowlists
- bounded `ssh_probe` and `ssh_exec`
- secret redaction and SSH regression tests

## v0.5 — Usable security-sensitive beta ✅

- permission status model
- locally issued time-limited elevation/full-control leases
- optional client-bound leases
- host filesystem tools behind full-control gates
- raw user-level shell behind full-control gates
- managed service hardening with `NoNewPrivileges=true`
- owner-controlled lease grant/revoke scripts
- release artifact smoke tests, doctor and safe uninstall

`v0.5` intentionally does **not** expose root/Administrator execution. Full control means the permissions of the OS account running the agent.

## v0.6 — Installable ChatGPT/Codex plugin ✅

- portable Agent Plugins `plugin.json`
- portable bundled MCP `mcp.json`
- `.codex-plugin/plugin.json` compatibility manifest
- repository marketplace at `.agents/plugins/marketplace.json`
- workstation-operator skill for safe engineering loops
- OpenAI install-surface metadata
- privacy and plugin usage disclosures
- plugin package validation in CI/prepack
- ChatGPT desktop/Codex marketplace installation guide
- explicit separation between local desktop distribution and future universal web/public distribution

The v0.6 local plugin keeps the MCP endpoint on `127.0.0.1`. It does not expose the workstation directly to the Internet.

## v0.7 — Authenticated identities + concurrent engineering sessions

- transport-authenticated principal identity where supported
- per-client roles/capability policy instead of observability tags alone
- session/task ownership
- Git worktree creation and lifecycle
- safe merge/review handoff between agents
- stronger conflict detection for non-file resources

## v0.8 — Engineering adapters

- typed Git write operations with policy gates
- Docker/container workflows
- serial/USB discovery and bounded I/O
- OpenOCD / GDB / ST-Link adapters
- STM32 / ESP32 build-flash-debug workflows
- ROS 2 process/topic/service adapters
- pluggable vendor/debug tools

Raw shell will remain available only as an explicitly elevated escape hatch; routine engineering operations should prefer typed adapters.

## v0.9 — Privileged helper + public web connection layer

- separately isolated privileged helper for narrowly scoped root/admin operations
- explicit owner approval protocol
- capability-specific sudo/root contracts rather than unrestricted privileged shell
- optional container/namespace sandbox for untrusted build/test workloads
- secure authenticated outbound workstation pairing/relay for ChatGPT web
- remote HTTPS MCP/app registration path suitable for public plugin review
- release artifact signing, provenance and SBOM

## v0.10 — Multi-agent orchestration

- task broker
- agent registry
- delegation contracts
- result aggregation
- worktree-aware parallel execution
- agent-to-agent workflows without weakening workstation policy

## v1.0 — Stable workstation control plane

Target criteria:

- compatibility validation across major MCP/plugin clients
- reproducible install/update/rollback
- hardened policy and authenticated identity model
- stable tool contracts
- operational documentation and migration guidance
- public/private distribution story with clear trust boundaries
- security review of workspace, SSH, update, full-control, public relay and privileged-helper boundaries
