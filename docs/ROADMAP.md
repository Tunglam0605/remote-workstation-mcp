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

## v0.8 - Multi-device control + remote resilience

This phase was accelerated after direct ChatGPT Web control was accepted on a real workstation.

### v0.8.0 - Hub-gateway MVP - complete

- one ChatGPT Web connection can reach one Remote Workstation Hub
- `device_list`, `device_probe`, and `device_exec` for owner-registered SSH devices
- hardened SSH allowlists, remote roots, host-key checking, timeout bounds and audit
- Windows tunnel watchdog with reconnect backoff and explicit `ONLINE / RECONNECTING / OFFLINE` state
- safe restart handoff through the persistent Control Center

### v0.8.1 - Managed-update launcher reliability - complete

- stable Windows launcher shipped in every runtime slot
- self-heal `bin/rwmcp.ps1` from the active slot
- real production upgrade/restart/reconnect validation

### v0.8.2 - Device identity and pairing - complete

- short-lived one-time pairing code
- stable paired-device identity and friendly name
- revocable per-device credential
- SSH bootstrap path and device inventory

### v0.8.3 - Direct Multi-Node - complete

- make one RWMCP + one OpenAI Secure MCP Tunnel per workstation the preferred topology
- no workstation-to-workstation SSH hop for routine ChatGPT control
- stable local `device-identity.json` independent of DHCP/IP changes
- expose `workstation_identity` and include identity in `chatgpt_web_status` / `system_info`
- use clear per-machine ChatGPT app names and allow ChatGPT to select multiple apps in one prompt
- add pinned SHA-256-verified Linux tunnel-client installer
- add Linux `systemd --user` Direct Node service with automatic restart/reconnect
- keep Hub/SSH mode only for bootstrap, migration and explicitly requested gateway workflows

### v0.8.4 - Offline-first Control Center Recovery - complete

- keep the loopback Control Center usable when the runtime API key is missing, expired or revoked
- keep the Control Center usable when a Tunnel ID changes/deletes or the OpenAI tunnel is disconnected
- separate local Control Center, MCP runtime and OpenAI tunnel health states
- add local-only recovery status/test/apply APIs that do not depend on the tunnel
- add **Test credentials** and **Save & reconnect** for Tunnel ID/runtime-key rotation
- store replacement Windows runtime keys with current-user DPAPI without reading them back into the browser
- bound runtime/update helper calls so broken child processes cannot hang the owner UI
- render explicit `OFFLINE` / `RECOVERY` states instead of permanent `Loading...`
- reclaim orphaned RWMCP setup-web listeners while still rejecting unrelated foreign processes

### v0.8.5 - Recovery and Linux release polish - complete

- automatically self-reload a stale local Control Center page when its ephemeral CSRF token expires after restart
- distinguish Linux source checkout installation from prebuilt GitHub Release installation
- make prebuilt Linux installation depend only on packaged `dist/` + runtime dependencies, not omitted TypeScript/test files
- retain v0.8.4 offline-first recovery and v0.8.3 Direct Multi-Node behavior

### v0.8.6 - Linux Direct Node upgrade hardening - current

- discover user-local Node.js from `$HOME/.local/bin` during non-interactive Direct Node setup
- preserve Direct Node topology during Linux upgrades instead of re-enabling the local-only service
- restart the configured Direct Node after slot activation so it immediately loads the new release

### v0.8.7 - Direct-node engineering ergonomics

- one-command Windows/Linux node enrollment once a tunnel ID/runtime key is available
- per-node health overview and deterministic app-name export
- device-scoped typed filesystem/Git/build/process contracts where cross-app orchestration benefits from explicit target metadata
- safe parallel execution and result aggregation across directly connected apps

## v0.9 — Engineering debug and hardware adapters

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

## v0.10 — Workstation automation + agent delegation + public hardening

- browser/Chrome DevTools and Playwright adapters
- Windows UI Automation fallback
- generic agent provider interface and task broker
- Codex/Claude/OpenHands/custom workers as optional providers
- delegation progress/cancellation/result aggregation
- harden privileged helper request envelopes and capability-specific contracts
- optional container/namespace sandbox for untrusted build/test workloads
- public Plugin Directory/App registration and review readiness
- release artifact signing, provenance and SBOM

## v0.7.8 — Tung Lam Control Center refresh ✅

- apply the `TungLamvsWebUI-Skills` visual invariants to the local Setup & Control Center
- dark mode by default with remembered light/dark theme toggle
- emerald/cyan industrial control-plane palette, responsive system status strip and hover/focus glow
- keep the daily surface mode-first: Read only / Workspace / Full access
- move Administrator approval into a native modal while preserving exact command/reason review and UAC
- keep detailed setup/runtime controls collapsed under Setup & advanced
- tolerate protected Windows entries during host filesystem directory listing

## v0.7.10 — Control Center ownership hardening ✅

- verify that the loopback listener on the Control Center port is a descendant of the managed Control Center host process
- never report a foreign process on port 8684 as a healthy managed Control Center
- refuse startup with a clear owning PID when the configured Control Center port is occupied by another process
- preserve the v0.7.9 install-once, stable auto-update and rollback model unchanged

## v0.7.9 — One-time Windows setup + automatic stable updates ✅

- publish a double-click `install-windows.cmd` bootstrap alongside the PowerShell installer
- verify the downloaded installer and runtime package with published SHA-256 manifests
- automatically install Node.js LTS and Git through `winget` when a new workstation is missing them
- keep normal users off the source-tree path: no clone, pull, rebuild or manual dependency install for routine operation
- start OpenAI mode through the stable `Boot` action after Windows sign-in
- check the stable release channel automatically when due, throttled to once per 12 hours
- install updates side-by-side into version slots without replacing owner configuration or DPAPI secrets
- validate runtime health and OpenAI tunnel readiness after activation
- roll back automatically to the previous slot when the new runtime cannot become healthy/ready
- persist failed-release backoff so a broken release is not retried on every sign-in
- expose owner-local update status/check/config APIs for the Control Center
- add Windows/Linux CI coverage for the updater/distribution contracts
- rewrite the Windows quick-start documentation around install-once operation and final Control Center screenshots

## v1.0 — Stable workstation control plane

Target criteria:

- compatibility validation across major MCP/plugin clients
- reproducible install/update/rollback
- hardened policy and authenticated identity model
- stable direct-control tool contracts
- operational documentation and migration guidance
- public/private distribution story with clear trust boundaries
- security review of workspace, SSH, update, full-control, remote connection, UI automation and privileged-helper boundaries
