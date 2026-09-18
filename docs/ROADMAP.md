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

### v0.8.6 - Linux Direct Node upgrade hardening - complete

- discover user-local Node.js from `$HOME/.local/bin` during non-interactive Direct Node setup
- preserve Direct Node topology during Linux upgrades instead of re-enabling the local-only service
- restart the configured Direct Node after slot activation so it immediately loads the new release

### v0.8.7 - Control Center UTF-8 and embedded-JS hardening - complete

- restore clean UTF-8 text, icons and Vietnamese translations in the local Control Center
- fix the embedded pairing-code newline that could break generated browser JavaScript
- parse the rendered `<script>` in automated tests so malformed generated JavaScript blocks release
- add mojibake regression assertions for known corruption signatures

### v0.8.13 - Conservative cross-platform update policy - complete

- auto-install verified patch releases only on managed Windows and Linux nodes
- detect minor/major releases without auto-installing them
- require explicit owner approval for minor/major stable updates
- expose check/install controls in the local Control Center on both Windows and Linux
- preserve SHA-256 verification, health checks, version slots and automatic rollback

### v0.8.12 - Linux bootstrap/update polish - complete

- discover existing user-local Node.js before downloading a runtime during Linux bootstrap
- reconstruct the user-systemd bus for update/restart operations launched from SSH, MCP or other non-interactive sessions
- preserve the v0.8.11 two-field first-run setup workflow unchanged

### v0.8.11 - First-run UX and one-step workstation onboarding - complete

- require only Tunnel ID + restricted Runtime API key for normal first-time setup
- add a dedicated WebUI first-run card and one-step bootstrap endpoint
- make TUI automatically enter setup when connection credentials are missing
- configure tunnel-client, Direct Node, startup, safe default ports/workspace and automatic updates without manual per-setting work
- publish `install-linux.sh` for verified release installation and user-local Node.js bootstrap on supported Linux architectures
- keep advanced settings available for experienced operators without putting them in the first-run path

### v0.8.10 - Linux Desktop Web Control Center parity - complete

- auto-enable the loopback-only Web Control Center on Ubuntu Desktop while retaining the terminal TUI
- share Linux Direct Node settings and permission policy between WebUI and TUI
- keep headless/server Linux TUI-first by default with an explicit `rwmcp-webui` launcher
- support Linux systemd --user runtime control and Runtime API key rotation from the local WebUI

### v0.8.9 - TUI launcher and non-interactive Direct Node polish

- expose `rwmcp-tui` as a stable Windows command through the managed per-user bin directory
- reconstruct Linux `systemd --user` bus variables for SSH/MCP/non-interactive TUI and upgrade workflows
- preserve v0.8.8 terminal controls and the standardized `8683` MCP default

### v0.8.8 - Terminal Control Center + direct-node ergonomics

- dependency-free interactive TUI (`rwmcp-tui`) for owner-local terminal administration
- terminal editing for access mode, MCP port, device name, Tunnel ID, and Runtime API key rotation
- TUI status surface for managed service, tunnel readiness, workspace, and current access mode
- Linux managed/direct-node default MCP port standardized on `8683`
- configuration changes reuse the same policy/scopes model as the Web Control Center and restart the managed runtime deterministically
- one-command Windows/Linux node enrollment once a tunnel ID/runtime key is available
- per-node health overview and deterministic app-name export
- device-scoped typed filesystem/Git/build/process contracts where cross-app orchestration benefits from explicit target metadata
- safe parallel execution and result aggregation across directly connected apps

## v0.9 - Engineering tools - current

### v0.9.4 - Always-on Windows Control Center recovery

- treat the loopback Control Center as the last-resort local recovery plane independent from MCP/tunnel health
- start Control Center before automatic update and OpenAI runtime activation during Boot
- fall back to the previous installed slot for Control Center recovery when the current slot is unusable
- keep Control Center alive through runtime update/rollback handoff
- watchdog-restart a crashed WebUI child with bounded backoff
- validate real child crash/recovery on Windows CI before release

### v0.9.3 - STM32/OpenOCD provider hardening

- add typed OpenOCD provider preflight with version/capability reporting and structured failure diagnostics
- permit only an owner-configured absolute `RWMCP_OPENOCD_EXECUTABLE` override; tool callers cannot supply executable paths
- add bounded SWD adapter-speed control to flash/verify/reset/debug workflows
- preserve ST-Link resource leasing, target-config allowlisting and project-subtree artifact containment
- keep mass erase, Option Bytes, RDP changes, arbitrary TCL/GDB commands, target memory write and GDB flash unavailable
- validate provider behavior with Windows/Linux simulated backends; keep real ST-Link board acceptance as an explicit pending hardware gate

### v0.9.2 - Durable Windows update transaction

- hand owner-approved Control Center updates to a detached worker outside the managed MCP/tunnel process tree
- persist update transaction state and logs outside version slots so disconnects do not lose progress/evidence
- preserve stable-launcher checksum/version-slot/rollback flow while making the HTTP request itself non-blocking
- give tunnel activation 180 seconds while allowing the supervisor to recycle a bad first child after 60 seconds
- attempt `StartOpenAI` recovery on the current or rolled-back slot if the update transaction fails
- simulate success/failure transaction paths in Windows CI before release

### v0.9.1 - Windows tunnel recovery hardening

- require fresh `commands_poll_last_successful_timestamp_seconds` before Windows reports the tunnel ONLINE
- distinguish local tunnel readiness from real control-plane polling
- recycle stale pollers automatically after bounded grace and retain exponential watchdog backoff
- make update/restart health gates fail closed when tunnel-client is locally alive but no longer polling OpenAI
- run a dedicated PowerShell parser/freshness regression in Windows CI

### v0.9.0 - Typed engineering foundation

- true PTY/ConPTY terminal sessions with caller ownership and bounded lifecycle/output
- cross-platform serial discovery and bounded serial sessions
- hardware resource leasing for probes/ports to prevent competing flash/debug/monitor operations
- firmware project/artifact inspection and typed ESP-IDF/CMake/Make build providers
- constrained OpenOCD/ST-Link flash-plan/flash/verify/reset workflows
- token-correlated GDB/MI debugging with halt/resume/step/stack/register/variable/breakpoint/memory-read/fault tools
- ROS 2 typed node/topic/service/action/parameter/bag workflows
- typed Docker container lifecycle/log/exec/image-build workflows
- project-subtree containment, target-config allowlisting, explicit probe/port identity and authenticated scope coverage
- pinned `node-pty`/`serialport` dependencies and packed native-module smoke tests



### v0.9.11 - Windows update convergence acceptance fix

- converge the complete managed runtime process tree across version-slot activation, including orphan MCP and OpenAI tunnel children;
- serialize Control Center startup inside the same cross-process runtime-start transaction used by MCP/tunnel startup;
- fail closed when the current runtime cannot be stopped safely before an update slot switch;
- make durable update transaction ownership monotonic by writing `STARTING` before worker spawn and preventing parent overwrite after handoff;
- gate release on the real-machine failure reproduced during the v0.9.10 Windows acceptance run.

### v0.9.10 - Stability hardening and self-convergence

- persist lifecycle epochs and live-owner interlocks across Boot/Start/Restart/Update/Rollback;
- converge stale supervisor state and duplicate managed runtime/tunnel processes only when ownership is provable;
- persist autonomous-recovery circuit state with bounded cooldown and a five-minute open state after six failed recovery attempts;
- fall back to the exact GitHub API release asset on transient browser-download HTTP 5xx while retaining SHA-256 verification;
- gate Windows releases with lifecycle, convergence, circuit-breaker, concurrent-start and heartbeat integration tests;
- require real-machine acceptance and soak without SSH/manual rescue after Windows reaches v0.9.10.

### v0.9.9 - Windows runtime-start serialization

- Serialize Windows runtime creation with a cross-process filesystem lock outside version slots.
- Re-check managed runtime state only after acquiring the lock so concurrent Boot/Update/Restart/Recovery callers converge on one supervisor.
- Add Windows CI coverage that launches two runtime Start operations concurrently and requires the same supervisor PID from both callers.
- Real-machine acceptance must show one runtime host, one MCP listener, one tunnel client, healthy recovery heartbeat, and no SSH/manual rescue.

### v0.9.8 - Autonomous Windows recovery supervisor

- persist `desired-state.json` outside version slots with owner Start/Stop intent and bounded maintenance deadlines
- keep explicit owner Stop authoritative across watchdog cycles and reboot/login paths
- supervise the WebUI child and autonomous recovery worker from the persistent Control Center host
- automatically restore a missing MCP/tunnel runtime through the stable launcher without SSH or manual UI actions
- escalate sustained MCP/tunnel health failures through the durable Restart handoff with bounded backoff
- require real-machine failure injection to pass without SSH rescue before treating the Windows node as stable

### Planned v0.9.x depth

- deeper real-hardware STM32/ST-Link acceptance and provider fallback
- ESP-IDF partition/app/security-state inspection and monitor workflow
- FreeRTOS task/stack diagnostics and RTT/SWO support
- ROS 2 and Docker production hardening
- richer provider error taxonomy, observability and recovery
- evaluate DAP/J-Link/pyOCD/probe-rs providers without changing the stable semantic contracts

Raw shell remains an explicitly elevated escape hatch; routine engineering operations should prefer typed adapters.

## v0.13 — Daily engineering workflows

### v0.13.3 - Active ST-Link preflight and external-owner detection

- actively prove that the selected ST-Link can be opened before `stm32.deploy_accept` starts a build;
- run a bounded adapter-only OpenOCD SWD `init -> shutdown` check without loading a target config and without reset, halt or program commands;
- hold and release one short probe lease around the preflight so failed access checks cannot leak ownership;
- parse target voltage when available and apply the configured/overridden `adapterSpeedKhz`;
- classify `LIBUSB_ERROR_BUSY`, failed interface claims and equivalent resource-busy errors as `probe-busy`;
- keep permission-denied and probe-not-found diagnostics distinct, and fail closed before build;
- use the stable discovered debug-probe ID as the resource ID when no usable ST-Link serial is present;
- preserve `actionSchemaVersion=2` and `engineeringApiVersion=3`.

This release is intentionally non-mutating at preflight time. Real hardware acceptance must show that the ready path opens the probe and reports voltage without reset/halt/flash, and that an externally owned probe is blocked as `probe-busy` before build with no leaked lease.

### v0.13.2 - STM32CubeIDE OpenOCD provider auto-discovery

- discover bundled OpenOCD from owner-configured CubeIDE roots, `C:\ST\STM32CubeIDE_*` and common STMicroelectronics install locations when PATH does not expose `openocd`;
- resolve CubeIDE's separate MCU debug-plugin `resources/openocd/st_scripts` root and require `interface/stlink.cfg` before treating the known install as usable;
- propagate the script root through `-s` for flash, independent verify, reset, transactional deploy and OpenOCD-backed debug sessions;
- preserve absolute owner overrides for both executable and scripts root, while keeping dangerous OpenOCD TCL surfaces unavailable;
- report the resolved executable source and script search path through typed provider status;
- preserve `actionSchemaVersion=2` and `engineeringApiVersion=3`.

Real workstation validation before release resolved STM32CubeIDE 2.2.0's STMicroelectronics OpenOCD 0.12.0+dev executable plus the matching `st_scripts` tree without PATH changes. After rollout, B300 deploy preflight should no longer block on provider availability; real flash acceptance remains gated only by an attached ST-Link/SWD probe (and the intended serial monitor port/readiness marker).

### v0.13.1 - Windows recovery-plane slot re-home hotfix

- re-home the loopback Control Center and autonomous recovery worker to the new active slot after Boot auto-update, manual Update and Rollback;
- verify the recovery plane is running, HTTP-healthy, owns its managed port and reports the exact requested runtime root;
- re-home again after rollback when a candidate slot fails recovery/runtime activation, while preserving explicit owner-stop state;
- add an executable Windows two-slot integration test proving the old host exits, the replacement host stays healthy and the recovery worker converges to the new slot;
- preserve `actionSchemaVersion=2` and `engineeringApiVersion=3`.

This hotfix was triggered by real v0.12.0 -> v0.13.0 production acceptance: the MCP/tunnel successfully moved to v0.13.0, while the old-slot recovery worker correctly self-terminated and left port 8684 unavailable because the manual-update path did not re-home the recovery plane.

### v0.13.0 - Transactional STM32 deploy acceptance

- add `stm32.deploy_accept` as the first daily-driver hardware workflow: provider/hardware/serial preflight -> build -> serial open -> atomic flash/verify/reset -> readiness-marker acceptance;
- keep flash, independent verify and reset inside one OpenOCD process and one exclusive ST-Link lease;
- fail closed with `blocked` status before build when OpenOCD, ST-Link selection or the configured monitor port is unavailable;
- open serial before target reset to capture early boot output, then close/release it in `finally` by default;
- keep `actionSchemaVersion=2` and move new runtime-only workflow fields behind the generic `parameters` envelope; advance `engineeringApiVersion` to 3;
- add regression coverage for preflight blocking, resource cleanup, serial readiness failure, explicit keep-open behavior and provider-level single-lease/single-process ordering.

Hardware acceptance note for the development workstation: v0.13.0 can be fully regression-tested without mutating hardware, but real flash acceptance remains gated until `hardware_list` discovers an ST-Link and the OpenOCD provider is installed/configured. The workflow is designed to report this as a structured blocked state rather than silently falling back to shell.

Next depth after v0.13.0:

- add owner-local provider provisioning/status guidance so missing OpenOCD/ST-Link backends are one-time setup rather than repeated per-chat discovery;
- add structured ARMCC/Keil compiler diagnostics and artifact summaries to workflow results;
- extend ESP-IDF daily workflows to OTA/partition/coredump acceptance;
- extend ROS 2 daily workflows to TF/QoS/topic-rate/Nav2/lifecycle diagnostics;
- add FreeRTOS task/stack high-watermark/watchdog telemetry workflows.

## v0.12 — Stable Engineering action surface + Keil multi-target workflows

### v0.12.0 - Keil MDK / frozen-snapshot-safe workflow contract

- detect Keil MDK `.uvprojx` projects and extract project targets, STM32 device IDs, output directories/names and expected AXF artifacts without executing project code;
- add a constrained Windows µVision build provider; RWMCP resolves `UV4.exe` from owner override/PATH/known install locations and generates batch argv internally;
- add `firmware.variants` plus `defaultVariant` so F407/H743/hardware-test targets share one canonical `.rwmcp/project.yaml` without guessing the active board;
- make the high-level ChatGPT Engineering API stable through string workflow IDs plus server-validated `parameters`, and accept a versioned generic profile envelope for profile initialization;
- expose `actionSchemaVersion` separately from runtime release version so custom-app action refreshes happen only when the actual action contract changes;
- validate the real B300 F407 target through the typed Keil provider on µVision 5.31; keep the H743 compile blocker (`Task_IPC.h` missing) classified as project diagnostics rather than provider failure;
- preserve shell-free project profiles, workspace containment and constrained provider command generation.

Next depth after v0.12.0:

- add owner-local multi-workspace management to WebUI/TUI so additional engineering roots can be authorized without hand-editing policy YAML;
- add structured ARMCC/Keil diagnostic parsing and warning/error summaries;
- add Keil provider version/capability detection before enabling optional newer command-line flags;
- continue STM32 ST-Link real-hardware flash/verify/debug acceptance, ESP-IDF OTA/coredump depth and ROS 2 Nav2/TF/topic-rate diagnostics.

## v0.11 — Reusable engineering workflows

### v0.11.0 - STM32 / ESP-IDF / ROS 2 workflow depth

- add STM32 build -> flash -> independent verify workflow;
- add one-call STM32 Cortex-M fault snapshot + stack workflow with guaranteed debug-session cleanup;
- add ESP-IDF build -> flash -> serial monitor -> readiness-marker acceptance without chat-side polling;
- add typed ROS 2 colcon build and build -> graph-health workflows with persisted distro/domain/package selection;
- add verbose ROS 2 topic endpoint/QoS inspection;
- retain data-only project manifests, explicit hardware identity, resource leases and no arbitrary shell/provider command surface.

## v0.10 — Engineering Workflow Engine

### v0.10.2 - Recovery-plane convergence hardening

- stale recovery workers self-terminate when managed `current.txt` points at another version slot;
- Control Center recovery startup converges old-slot and duplicate managed recovery workers before spawning the current worker;
- successful updater activation clears obsolete failed-release backoff metadata;
- real-machine acceptance requires exactly one current-slot recovery worker after update.

### v0.10.1 - Windows WebUI update handoff acceptance hotfix

- replace Node detached-spawn update handoff with a CIM/Win32_Process.Create starter so the durable worker is outside the managed runtime/Control Center process tree;
- require RUNNING/SUCCEEDED worker acknowledgement before returning an accepted update response;
- fail closed when the worker exits before acknowledgement and preserve terminal FAILED state from the worker;
- treat an unacknowledged STARTING transaction with no worker PID as stale after a short startup grace;
- add real Windows CI coverage for the CIM parent boundary, success path and early worker exit.

The v0.10 priority is reducing repeated per-chat engineering setup and shell command sequences now that Direct Node control is stable.

- add project-local .rwmcp/project.yaml as the canonical recurring engineering configuration;
- add typed project inspection/profile initialization plus workflow list/plan/run tools;
- add built-in firmware build -> flash/verify -> serial monitor compound workflows with fail-fast semantics;
- add profile-driven ROS 2 distro/workspace/ROS_DOMAIN_ID bootstrap and a one-call graph health workflow;
- keep manifests data-only: no arbitrary shell recipes, executable paths, OpenOCD TCL or GDB commands;
- preserve workspace containment, authenticated scopes, hardware resource leases and audit records across compound workflows;
- deepen STM32/ST-Link real-hardware acceptance, provider fallback and HardFault workflow;
- deepen ESP-IDF monitor/expect/coredump/OTA workflows;
- deepen ROS 2 build/launch/TF/QoS/topic-rate/Nav2/diagnostics/bag workflows;
- add controlled project toolchain/provider provisioning so missing backends become an actionable setup state instead of repeated manual discovery.

### After the workflow layer is stable

- browser/Chrome DevTools and Playwright adapters;
- Windows UI Automation fallback;
- generic agent provider interface and task broker;
- Codex/Claude/OpenHands/custom workers as optional providers;
- delegation progress/cancellation/result aggregation;
- harden privileged helper request envelopes and optional workload sandboxing;
- public Plugin Directory/App review readiness, release signing, provenance and SBOM.

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

### v0.9.6 - Durable Windows restart handoff

- Persist restart transaction state and bounded worker logs.
- Serialize restart handoffs with a per-user mutex.
- Control Center waits for worker startup acknowledgement before returning HTTP 202.
- If Restart fails after stopping the runtime, the worker automatically attempts a typed Start recovery.
- Windows CI simulates both restart success and restart-failure recovery.
