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
- Windows runtime setup and CI validation

The local/repo plugin mapping remains loopback-only and does not publish the workstation directly to the Internet.

## v0.7 — Direct engineering control foundation ✅

Primary design rule: **ChatGPT/GPT Web is a first-class controller. Codex, Claude and other coding agents are optional workers, never a required hop.**

Completed direct-control foundation:

- request-scoped authenticated HTTP principals and workstation scopes
- local owner policy + time-limited client-bound leases remain authoritative
- typed Git history, branches, staging, commits and worktrees
- structured GCC/Clang/MSVC/CMake build diagnostics
- principal-owned managed process sessions with bounded incremental output
- bounded interactive pipe stdin via `process_write` and `process_close_stdin`
- owner-configured LSP definitions, references, hover, document symbols and diagnostics
- LSP process/message bounds and workspace-external path redaction
- transport-provider separation for stdio vs loopback Streamable HTTP
- connection-provider separation above MCP transport
- outbound-only OpenAI Secure MCP Tunnel path for ChatGPT/cloud use
- ephemeral workstation bearer injection into tunnel runtime/discovery requests
- OpenAI runtime credential separation from the MCP child process
- verified Windows installer for the pinned official OpenAI `tunnel-client`
- Linux + Windows CI coverage for the direct-control core

A tunnel connection is reachability, not authorization. The remote path still terminates at the authenticated loopback MCP boundary, then passes through scopes, policy, leases and audit before any workstation adapter executes.

## v0.8 — Engineering debug and hardware adapters

- true PTY/ConPTY terminal adapter with bounded lifecycle and output
- DAP session adapter for language-agnostic debugger control
- GDB/MI adapter for native/source-level debugging
- Docker/container workflows
- serial/USB discovery and bounded I/O
- OpenOCD / ST-Link / J-Link adapters
- STM32 / ESP32 build-flash-debug workflows
- crash/fault/register diagnostics
- RTT/SWO/log streaming through bounded cursors
- ROS 2 process/topic/service/action/parameter adapters
- richer LSP rename preview/code-action contracts

Raw shell remains an explicitly elevated escape hatch; routine engineering operations should prefer typed adapters.

## v0.9 — Workstation automation + public distribution hardening

- browser/Chrome DevTools adapter
- Playwright/browser testing adapter
- Windows UI Automation adapter as fallback when no CLI/API/debug protocol exists
- separately isolated privileged helper for narrowly scoped root/admin operations
- explicit owner approval protocol for privileged operations
- capability-specific sudo/root contracts rather than unrestricted privileged shell
- optional container/namespace sandbox for untrusted build/test workloads
- public Plugin Directory/App registration documentation and review readiness
- reconnect/revocation observability for remote connection providers
- release artifact signing, provenance and SBOM

## v0.10 — Optional multi-agent delegation

- generic agent provider interface
- task broker and agent registry
- Codex/Claude/OpenHands/custom workers as optional providers
- delegation contracts, progress events and cancellation
- result aggregation
- worktree-aware parallel execution
- non-file resource conflict detection and safe merge/review handoff
- agent-to-agent workflows without weakening workstation policy

## v1.0 — Stable workstation control plane

Target criteria:

- compatibility validation across major MCP/plugin clients
- reproducible install/update/rollback
- hardened policy and authenticated identity model
- stable direct-control tool contracts
- operational documentation and migration guidance
- public/private distribution story with clear trust boundaries
- security review of workspace, SSH, update, full-control, remote connection, UI automation and privileged-helper boundaries
