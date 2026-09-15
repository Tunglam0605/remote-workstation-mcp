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

## v0.7.2 — ChatGPT Web onboarding + new-machine setup ✅

- loopback-only owner Setup Console for first-run workstation onboarding
- ephemeral in-memory CSRF token, same-origin check, no-store responses and loopback client enforcement
- persisted non-secret workstation settings outside the repository
- Windows DPAPI protection for the OpenAI runtime API key
- Windows launchers automatically reuse saved MCP port, tunnel id, organization id and cloudflared preference
- Setup Console can install/verify the pinned official OpenAI `tunnel-client`
- existing owner policy and SSH host config are never silently overwritten
- dedicated ChatGPT Web custom app guide and connector handoff
- explicit separation between portable plugin packaging and ChatGPT Web tunnel attachment

The setup browser is an owner-local bootstrap surface, not an MCP capability exposed to AI clients.

## v0.7.3 — Managed Windows distribution + local control center ✅

- production Windows installation from GitHub Release assets without requiring a repository clone
- SHA-256 verification before release-package extraction
- current-user version slots with stable `current` / `previous` pointers and owner-triggered rollback
- policy, SSH hosts, settings, audit data and DPAPI secrets persist outside application version slots
- stable per-user launcher for setup, runtime control, update and rollback
- Start Menu entry for the local Setup & Control Center
- Setup Console upgraded to runtime Control Center with start/stop/restart and health/readiness status
- optional current-user start-at-logon (initially implemented with a limited Scheduled Task; superseded by v0.7.5 user-level registry startup)
- runtime supervisor validates recorded process identity before terminating its descendant tree
- official pinned OpenAI `tunnel-client` remains checksum-verified and follows the active version slot
- GitHub Release publishes a standalone `install-windows.ps1` alongside the package and checksums

Windows distribution operations remain owner-local. They are not MCP tools and cannot grant full-control scopes, enable dangerous policy gates or create permission leases.

## v0.7.4 — ChatGPT Web end-to-end control acceptance ✅

- `chatgpt_web_status` proves that a request reached the workstation through the authenticated ChatGPT/OpenAI tunnel principal
- the verification response reports non-secret host identity, effective scopes, policy mode and authorized workspace names
- the tool is explicitly classified as `workstation.read` and audited like every other remote action
- ChatGPT Web setup documentation now has a deterministic first-call and safe read/write/execute acceptance sequence
- direct-control completion criteria are explicit before any multi-device/plugin-first expansion begins
- full-control remains excluded from the default tunnel scope and is not required for acceptance

The v0.7.4 milestone is considered complete at runtime only after ChatGPT Web itself calls `chatgpt_web_status` and reports `directControlPathVerified: true`, followed by controlled read/write/execute checks in an owner-authorized workspace.

## v0.7.5 — Windows setup reliability hotfix ✅

- replace Scheduled Task registration with current-user `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` startup so standard-user installations do not fail with `Access is denied`
- preserve compatibility detection and best-effort cleanup for legacy Scheduled Task registrations
- wait for OpenAI tunnel `/readyz` before the managed `StartOpenAI` action reports success
- fail clearly when a local-only managed runtime is already active instead of silently treating it as an OpenAI tunnel runtime
- add Windows CI coverage for register/unregister start-at-logon without Administrator privileges

This hotfix keeps the setup flow owner-local and non-elevated: `Prepare this PC for ChatGPT` should finish with MCP healthy, tunnel ready, bearer auth active and start-at-logon enabled without requiring Administrator rights.

## v0.7.6 — Persistent Control Center + owner permission UX ✅

- keep MCP transport and owner Control Center on separate loopback ports (default `8683` / `8684`)
- redirect local browser navigation from the MCP root or `/setup` to the Control Center while preserving MCP/API behavior
- run the Control Center as an independent supervised process so runtime restart does not tear down the page
- bilingual English/Vietnamese UI with browser-language default and persisted manual selection
- expose explicit owner controls for tunnel scopes, host-filesystem/raw-shell gates, and short `full_control` leases bound to `openai-tunnel`
- preserve the three-layer full-control model: authenticated scope + local gate + active client-bound lease
- tolerate Windows UTF-8 BOM settings files and distinguish managed-runtime port ownership from unrelated port conflicts
- retain safe defaults: read/write/execute enabled, host-wide gates off, no full-control lease, Administrator/sudo unavailable

## v0.7.7 — Codex-style modes + Administrator approval gateway ✅

- simplify the daily Control Center to three owner-selected access modes: Read only, Workspace and Full access
- move workstation/tunnel/runtime internals under a collapsed Setup & advanced section
- make Full access a persistent user-level owner mode for host filesystem + raw shell; it never grants Administrator
- add `workstation.admin_request` as request-only transport authority
- add `admin_request` / `admin_request_status` tools that can create/check pending requests but cannot approve themselves
- persist expiring pending requests with requesting principal, exact executable, argv, cwd, reason and command hash
- show an approval card only while an Administrator request is active
- bind local approval to the exact request file SHA-256 before elevation
- launch one separately isolated Windows helper through `RunAs`; the local owner approval remains mandatory; Windows RunAs/UAC performs elevation according to OS policy
- reject direct privileged shell hosts in the helper and execute one direct `.exe`/`.com` application per approval
- keep the normal MCP, tunnel and Control Center processes non-elevated
- preserve legacy client-bound leases for compatibility/temporary workflows without showing their internals in the daily UI

## v0.8 — Engineering debug and hardware adapters

This work begins **after** the direct ChatGPT Web control path above is accepted on a real ChatGPT workspace.

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
- harden the v0.7.7 privileged helper with signed/provenance-aware request envelopes and richer capability-specific contracts
- expand privileged actions through typed adapters instead of unrestricted privileged shell
- optional container/namespace sandbox for untrusted build/test workloads
- public Plugin Directory/App registration documentation and review readiness
- reconnect/revocation observability for remote connection providers
- release artifact signing, provenance and SBOM

## v0.10 — Optional plugin-first multi-device / agent delegation

Only begin this phase after ChatGPT Web acceptance is complete.

- one ChatGPT app/plugin installation with paired workstation identities
- short-lived one-time device pairing
- outbound authenticated device sessions and revocable per-device credentials
- stable MCP Hub router preserving principal/scopes/policy/audit
- Windows one-click paired-agent bootstrap
- generic agent provider interface
- task broker and agent registry
- Codex/Claude/OpenHands/custom workers as optional providers
- delegation contracts, progress events and cancellation
- result aggregation
- worktree-aware parallel execution
- non-file resource conflict detection and safe merge/review handoff
- agent-to-agent workflows without weakening workstation policy

## v0.7.8 — Tung Lam Control Center refresh ✅

- apply the `TungLamvsWebUI-Skills` visual invariants to the local Setup & Control Center
- dark mode by default with remembered light/dark theme toggle
- emerald/cyan industrial control-plane palette, responsive system status strip and hover/focus glow
- keep the daily surface mode-first: Read only / Workspace / Full access
- move Administrator approval into a native modal while preserving exact command/reason review and UAC
- keep detailed setup/runtime controls collapsed under Setup & advanced
- tolerate protected Windows entries during host filesystem directory listing

## v1.0 — Stable workstation control plane

Target criteria:

- compatibility validation across major MCP/plugin clients
- reproducible install/update/rollback
- hardened policy and authenticated identity model
- stable direct-control tool contracts
- operational documentation and migration guidance
- public/private distribution story with clear trust boundaries
- security review of workspace, SSH, update, full-control, remote connection, UI automation and privileged-helper boundaries
