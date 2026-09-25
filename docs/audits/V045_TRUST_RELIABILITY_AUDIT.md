# RWMCP v0.45.0 Trust & Reliability Audit

Status: completed baseline audit before further professional-tool expansion  
Baseline: `v0.45.0` / Action Schema 21 / Engineering API 5  
Audit date: 2026-09-25  
Scope: all advertised RWMCP capability families, their execution boundaries, major professional providers, and production/release evidence.

## 1. Audit rule

This review distinguishes **working in the current environment** from **trustworthy by contract**.

Evidence is ranked in this order:

1. official vendor/specification documentation and upstream source;
2. documented machine-oriented CLI/API contracts;
3. RWMCP source-level safety boundaries and fail-closed behavior;
4. reproducible automated tests / Windows and Linux CI;
5. live production provider evidence.

A tool is not labelled reliable merely because one smoke test passed.

### Decision vocabulary

- **TRUSTED** — implementation is aligned with a documented stable interface, has bounded/fail-closed handling, and has adequate regression evidence.
- **TRUSTED-WITH-CONSTRAINTS** — safe and useful within explicitly stated compatibility/performance/provider limits.
- **HARDEN** — current capability is usable, but a concrete reliability/portability/provenance gap should be corrected before broader expansion.
- **REPLACE** — current interface is fundamentally unsuitable for deterministic machine operation.
- **DEFER** — do not expose/expand until lifecycle, cancellation, provenance, or safety semantics are complete.

## 2. Baseline evidence

### Release / build

- Production release: `v0.45.0`.
- Release package, SHA256SUMS and CycloneDX SBOM are published.
- Windows CI and Linux CI passed for the release.
- Clean-worktree reproduction:
  - `npm ci --no-audit --no-fund` — PASS;
  - `npm run typecheck` — PASS;
  - `npm run build` — PASS;
  - `npm run plugin:validate` — PASS;
  - Git worktree remained clean.
- `npm audit --omit=dev --audit-level=moderate`: **0 known vulnerabilities** at audit time.
- The earlier missing `playwright-core` error on the long-lived main checkout was reproduced as local dependency-install drift; a clean `npm ci` restored a fully passing typecheck/build.

### Production nodes

| Node | Runtime | Current evidence |
| --- | --- | --- |
| Windows `TungLamAutomation` | v0.45.0 / AS21 / API5 | healthy; direct path verified; Chrome provider available; OpenOCD available |
| Ubuntu Personal `aubot-tech65` | v0.45.0 / AS21 / API5 | healthy; direct path verified; OpenOCD unavailable |
| Ubuntu Vision `aubot-tech` | v0.45.0 / AS21 / API5 | healthy; direct path verified; owner-overridden OpenOCD available |

### Current worker providers on Windows

- Codex CLI: `0.156.1`, available through owner-selected account broker.
- Google Antigravity CLI: `1.2.11`, available with sandboxed headless policy.
- Worker registration remains owner-local and is not an MCP permission-grant surface.

## 3. Official / upstream reference set

| Domain | Primary authority |
| --- | --- |
| MCP | Model Context Protocol official TypeScript SDK and current protocol specification |
| Git | git-scm official `git-status`, `git-worktree`, refs and revision documentation |
| Node process | Node.js `child_process` documentation |
| PTY | microsoft/node-pty upstream |
| Serial | serialport/node-serialport upstream documentation |
| SSH | OpenSSH client manual |
| LSP | Microsoft Language Server Protocol specification |
| OpenOCD | OpenOCD User Guide and upstream source |
| GNU GDB | GNU GDB manual / GDB-MI specification |
| STM32 vendor path | ST STM32CubeProgrammer and STM32CubeIDE documentation |
| CMSIS-SVD | Arm CMSIS-SVD specification/schema |
| ROS 2 | ROS 2 docs, ros2cli, rclpy/rclcpp, tf2, lifecycle/action sources |
| ESP-IDF | Espressif ESP-IDF Programming Guide / idf.py |
| PlatformIO | PlatformIO Core CLI documentation |
| Keil | Arm Keil MDK / µVision command-line documentation |
| Docker | Docker CLI reference |
| systemd | freedesktop.org systemctl/journalctl manuals |
| KiCad | KiCad versioned CLI documentation and upstream source |
| Office | Microsoft Learn Office object model + ISO/IEC 29500 / Open XML SDK |
| Browser | Microsoft Playwright upstream documentation |
| NotebookLM | Google NotebookLM product/help documentation |
| Codex | OpenAI Codex official repository/documentation |
| Antigravity | Google Antigravity official repository/changelog |

## 4. Trust matrix

| Domain / capability IDs | Current implementation | Contract / evidence | Reliability decision | Required constraint or action |
| --- | --- | --- | --- | --- |
| MCP transport: `transport.providers`, `transport.auth.http`, `connection.openai_secure_tunnel` | Official MCP v2 packages, stdio + loopback Streamable HTTP, outbound secure tunnel, scoped bearer principal | Official MCP SDK is the canonical TypeScript implementation; runtime tests verify auth/request-scoped principals | **TRUSTED** | Keep tunnel reachability separate from workstation authorization |
| Workspace/filesystem: `workspace.discover`, `filesystem.read`, `filesystem.write` | PathGuard, symlink/traversal containment, SHA-256 optimistic concurrency | Local security tests cover traversal/symlink and stale-write rejection | **TRUSTED** | Do not widen host FS access into normal workspace tools |
| Git: `git.inspect`, `git.manage` | argv-based `execFile`, typed branch/worktree writes; worktree list uses `--porcelain`; status uses `--short --branch` | Git explicitly guarantees `--porcelain` formats for scripts; short format is not the strongest machine contract | **HARDEN** | Change status to a porcelain contract; preserve `--` path/ref disambiguation and typed writes |
| LSP: `code.semantic` | Owner-allowlisted language server, JSON-RPC/LSP, time/message bounds, external-path redaction | LSP 3.18 is a documented machine protocol | **TRUSTED** | Keep server executable owner-controlled and workspace paths redacted |
| Managed process: `process.execute`, `task.run`, `build.diagnostics` | `shell=false`, bounded streams, process-tree supervisor, typed task allowlist/diagnostic parsers | Node documents direct spawn/execFile semantics; tests verify child/grandchild cleanup | **TRUSTED** | Raw shell remains a separate full-control capability |
| PTY: `terminal.pty` | per-session PTY worker, executable allowlist, ConPTY/POSIX, bounded output and ownership | node-pty is established upstream and used by VS Code; 200-cycle soak is an acceptance gate | **TRUSTED-WITH-CONSTRAINTS** | Current dependency is exact-pinned pre-release `1.2.0-beta.14`; track stable upstream and keep soak tests |
| Serial: `engineering.serial` | serialport provider, stable device selectors, exclusive resource lease, bounded sessions | SerialPort has documented cross-platform stream/bindings API | **TRUSTED-WITH-CONSTRAINTS** | Native binding install script is a supply-chain surface; preserve exact version + CI native smoke |
| SSH recovery: `remote.ssh`, `multi_device.hub_gateway` | default disabled; owner host/program allowlist; BatchMode; no forwarding; no TTY; host-key checking | OpenSSH documents these controls; RWMCP quotes POSIX argv and uses encoded PowerShell literals on Windows | **TRUSTED** | Keep as recovery/bootstrap only; do not restore hub authority as default |
| Multi-node: `multi_device.direct_nodes`, `multi_device.data_plane`, `multi_device.authorization`, `multi_device.control_plane_relay` | independent Direct Nodes; directional grants; source/destination authorization; SHA-bound transfers; relay fallback | Security regression tests cover wrong principal, revocation, workspace/path/extension/size/transport binding | **TRUSTED** | Keep cross-node default deny and dedicated scope independent of full_control |
| Work Session / coordination: `work_session.execution`, `project_session_group.coordination`, `project.multichat_status`, `work_session.workflow_runs`, `work_objective.task_graph` | durable owner-scoped sessions, isolated worktrees, deterministic task DAG, restart reconciliation, resource interlocks | Extensive restart/ownership/concurrency regression evidence | **TRUSTED** | Coordination metadata must never become authorization |
| Execution/routing: `execution.policy`, `agent.worker_provider_registry`, `agent.routing`, `agent.orchestration` | owner policy + per-session narrowing; provider registry read-only to MCP; fallback bounded by authority | Local tests verify no widening, worktree requirement and fallback state | **TRUSTED** | Keep ChatGPT/human as planning authority; workers remain subordinate executors |
| Codex worker / broker: `agent.codex_account_broker` + Codex target | official local Codex CLI, isolated worktree, sandbox attestation, process-tree cancellation, fail closed if header absent | Official Codex supports sandbox/approval controls, but machine JSON/error output continues evolving upstream | **TRUSTED-WITH-CONSTRAINTS** | Treat exit code + sandbox attestation + Git evidence as authoritative; never rely solely on free-form or optional JSON error fields |
| Antigravity worker: `agent.antigravity_worker` | official `agy`, stream-json stdin/stdout, `--sandbox`, required sandbox policy, bounded worktree/evidence | Official headless JSON/stream-json exists, but upstream is rapidly evolving and has recent headless-result bugs | **HARDEN** | Reject suspicious empty `SUCCESS`; capability/version-probe event contract; keep no dangerous permission bypass |
| Quality learning: `quality_learning.telemetry`, `quality_learning.knowledge` | evidence-gated advisory knowledge, owner review/promotion, no execution authority | Internal contract has deterministic eligibility/revalidation tests | **TRUSTED** | Never let learned recommendations grant permissions or auto-promote execution |
| Browser: `web.automation` | Playwright managed context/persistent profile, semantic references, exact-host navigation policy, controlled uploads/downloads | Playwright documents isolated BrowserContext, persistent context, downloads and locator auto-wait | **TRUSTED-WITH-CONSTRAINTS** | Browser DOM remains site-dependent; keep semantic generations and no raw JS/CDP/coordinate authority |
| NotebookLM: `web.notebooklm` | owner-authenticated Existing Chrome claim + semantic site adapter + postcondition-driven video/ask waits | Google documents NotebookLM features, not a stable public DOM automation API | **TRUSTED-WITH-CONSTRAINTS** | Explicitly label as site-adapter; add feature-contract smoke/version evidence; expect UI drift |
| Local setup/recovery: `setup.local_web`, `setup.local_tui`, `control_center.offline_recovery`, `installation.windows_managed`, `software.update.check` | loopback owner UI/TUI, version slots, checksum assets, rollback, recovery/watchdog | Release CI and managed installer tests cover slot switching/recovery; release assets include SHA256 + SBOM | **TRUSTED** | Owner-local mutation only; update remains release/checksum gated |
| Full-control: `permission.elevation`, `full_control.host_filesystem`, `full_control.shell`, `full_control.admin` | explicit time-limited/client-bound lease plus separate dangerous gates | Regression tests prove full_control does not bypass feature gates | **TRUSTED AS SECURITY BOUNDARY** | Do not reuse these surfaces as implementation shortcuts for professional tools |
| STM32/OpenOCD: `engineering.hardware`, `engineering.firmware` | fixed OpenOCD argv, explicit probe serial, packaged target config, leases, `program ... verify`, no arbitrary TCL/OB/RDP/memory-write | OpenOCD documents `program ... verify` and `verify_image`; v0.44 removed duplicate verification | **TRUSTED-WITH-CONSTRAINTS** | Windows build is identifiable; Ubuntu Vision reports a `-dirty` OpenOCD build and therefore has weaker provenance |
| STM32 vendor backend | OpenOCD is default; CubeProgrammer not an execution provider | ST officially supports SWD/JTAG/bootloader read/write/verify plus ST-specific programming features | **DEFER** optional ST provider | Add only when an ST-specific capability is needed; do not broaden OB/RDP/mass-erase authority |
| GDB/MI: `engineering.debug` | `mi2`, bounded recursive tuple/list parser, documented MI commands, `-data-read-memory-bytes`, no arbitrary GDB/write | GNU recommends pinning MI version for frontends; memory-bytes is current interface | **TRUSTED** | Add fixture corpus across Arm GDB versions; keep fixed high-level operations |
| CMSIS-SVD: `stm32_svd_inspect` under engineering tooling | bounded project XML parser, DTD/entity rejection, arrays/clusters/fields, reports `derivedFrom` | Arm SVD is vendor-maintained device metadata and explicitly supports `derivedFrom` inheritance | **TRUSTED-WITH-CONSTRAINTS** | Current parser reports but does not resolve all `derivedFrom` inheritance; inspection is safe, but do not use it as authoritative live-write metadata yet |
| ESP-IDF: `engineering.firmware` / workflows | typed idf.py build/size/monitor/provider operations and bounded JSON where available | Espressif documents idf.py build/flash/monitor/size; semantics can evolve by major IDF release | **TRUSTED-WITH-CONSTRAINTS** | Add version capability probes for IDF 6.x incremental flash/verify changes; keep target/version evidence |
| PlatformIO: `engineering.platformio` | official `project metadata --json-output`, config lint, system info, device JSON; no upload fallthrough | PlatformIO documents these JSON/CLI operations | **TRUSTED** | Continue preferring JSON-output commands and explicit project provider |
| Keil | typed µVision batch build, target selection, license inferred only from bounded build evidence; no IDE automation/flash | Keil batch build is vendor-supported, but licensing/toolchain vary by installation | **TRUSTED-WITH-CONSTRAINTS** | Keep exact target selection, no arbitrary µVision command surface |
| ROS2: `engineering.ros2` | typed rclpy helper for Hz/BW/TF when distro configured; bounded CLI fallback; lifecycle allowlist | rclpy is canonical Python API; ros2cli is official. Subscription-observed rate is not publisher truth | **TRUSTED-WITH-CONSTRAINTS** | No live rclpy acceptance on current production nodes; Python sampler is not suitable as precision truth for very high-rate topics |
| ROS2 action goal send | intentionally absent | Process kill does not prove server-side action cancellation; durable goal handle/UUID lifecycle is required | **DEFER** | Implement only with ActionClient handle persistence, cancel acknowledgement and restart recovery |
| Docker: `engineering.containers` | CLI inspect/logs/stats machine formats, typed lifecycle, explicit high-risk classification | Docker documents JSON inspect, logs and `stats --no-stream --format` | **TRUSTED-WITH-CONSTRAINTS** | Remote/privileged/high-risk daemon use must remain separately owner-authorized |
| systemd: `engineering.systemd` | `systemctl show --property`, JSON journal, exact-unit restart allowlist | systemctl `show` is intended for machine parsing; journalctl supports structured output | **HARDEN** minor | Journal subprocess non-zero currently returns `available:true` plus exitCode instead of explicit degraded/error state |
| KiCad: `engineering.kicad` DRC/ERC/BOM/fabrication | JSON reports, temp outputs, parity, bounded parser, fixed BOM fields, source-preserving fabrication | Versioned KiCad CLI documents DRC/ERC JSON and fabrication commands | **TRUSTED** for DRC/ERC/BOM/fabrication | Keep no-source-mutation and isolated output manifest |
| KiCad board statistics / diagnostics | unconditional `pcb export stats --format json` when board exists | `pcb export stats` is documented in current/master, but not in older 8/9 CLI documentation | **HARDEN — PRIORITY** | Capability-probe or version-adapt; diagnostics should degrade without stats instead of failing wholesale |
| Word: `office.word.inspect`, `office.word.mutate` | deterministic OOXML + OMML typed operations, transaction/rollback, optional native Word acceptance | Open XML/Office object models are vendor standards; active content not executed | **TRUSTED-WITH-CONSTRAINTS** | Keep public Office Windows-only and fail closed on unsupported semantics |
| Excel: `office.excel.inspect`, `office.excel.mutate` | typed OOXML edits, static risky-formula scan, no external link update, ForceDisable around Open, full recalculation/PDF acceptance | Microsoft documents Workbooks.Open, AutomationSecurity, CalculateFullRebuild and ExportAsFixedFormat | **TRUSTED-WITH-CONSTRAINTS** | Static formula gate is conservative threat reduction, not a formal proof against every future Excel feature |
| PowerPoint: `office.powerpoint.inspect`, `office.powerpoint.mutate` | text-only OOXML edits preserving simple formatting, fail closed on complex text, read-only native Open + PDF | Microsoft object model and OOXML contracts support architecture | **TRUSTED-WITH-CONSTRAINTS** | Continue refusing complex formatting rather than lossy mutation; prefer ExportAsFixedFormat wrapper if/when binder is made deterministic |
| OOXML package layer: `office.core` | bounded ZIP/OPC/XML, traversal/OLE/encryption limits, unchanged-part preservation | ISO 29500/Open XML SDK is reference model; custom Node implementation is intentionally low-level | **TRUSTED-WITH-CONSTRAINTS** | Optional official SDK validator can be an additional acceptance stage; do not migrate merely for SDK branding |

## 5. Supply-chain assessment

The production dependency set is small and currently has no known `npm audit` finding, but three dependencies execute native/postinstall scripts during installation:

- `@serialport/bindings-cpp@13.0.0`;
- `esbuild@0.28.2`;
- `node-pty@1.2.0-beta.14`.

This is normal for native/tooling dependencies but is a distinct trust boundary.

Decision: **HARDEN** CI/install policy with explicit approved install-script packages, exact lockfile evidence, SBOM retention and packaged-runtime smoke tests. Do not silently permit arbitrary new dependency install scripts.

## 6. Top reliability gaps

### P0 — KiCad version portability

`diagnostics()` unconditionally calls `pcb export stats` for a board. The command is present in newer/current KiCad documentation but not the older KiCad 8/9 CLI contract. A diagnostic bundle should not fail only because an optional statistic command is unavailable.

**Required:** capability probe/version adapter + graceful degradation.

### P1 — Git status machine contract

RWMCP currently requests `git status --short --branch`. Git explicitly provides `--porcelain` for scripts and guarantees its stability.

**Required:** use a porcelain version for programmatic status.

### P1 — Provider provenance

The Ubuntu Vision OpenOCD provider reports:
`0.12.0+dev-02228-ge5888bda3-dirty`.

The binary can still work correctly, but the `dirty` suffix weakens reproducibility. RWMCP should expose provider provenance/trust warnings rather than treat executable presence + version as equal evidence to a clean vendor/upstream build.

### P1 — Antigravity false-success defense

Current dispatch accepts `status=SUCCESS` + exit 0 even if the structured result is suspiciously empty. Recent upstream headless bugs make this an avoidable weak point.

**Required:** fail or degrade suspicious empty-success outcomes and report the CLI/event-contract version evidence.

### P2 — CMSIS-SVD inheritance completeness

The v0.45 parser returns `derivedFrom` metadata but does not fully materialize inherited peripheral/register/field content.

**Required before any live register-value feature:** resolve/validate inheritance or expose explicit `inheritanceResolved=false` semantics. Current read-only inspection may remain available.

### P2 — systemd journal degraded state

A failing `journalctl` invocation currently yields `available:true` with an exit code. That is observable but not semantically explicit.

**Required:** classify journal collection as `ok/degraded/unavailable` without turning a healthy `systemctl show` result into a total failure.

### P2 — ROS2 native live matrix

The helper contract and tests are strong, but current production nodes do not supply a ROS2/rclpy live graph acceptance environment.

**Required:** maintain a Humble/current fixture or dedicated ROS test node before claiming production live precision; keep CLI fallback.

### P2 — native dependency install scripts

New install-script-bearing dependencies could silently widen the package installation trust surface.

**Required:** CI policy/allowlist and diff check on the approved set.

## 7. Explicit DO NOT CHANGE boundaries

- no arbitrary GDB command;
- no arbitrary OpenOCD TCL;
- no generic memory-write/Option Bytes/RDP/mass erase;
- no ROS action-goal dispatch until durable cancellation/recovery exists;
- no raw COM/VBA as public Office tools;
- no Office macro/template mutation;
- no KiCad source refill/save as part of diagnostics/fabrication;
- no browser raw JavaScript/CDP/password/cookie/token extraction;
- no worker self-registration or authority widening;
- no cross-node implicit trust;
- no automatic permission grants;
- no learned-knowledge promotion into execution authority;
- no Docker high-risk bypass through ordinary engineering permissions;
- no legacy SSH hub as the default multi-node architecture.

## 8. Approved hardening sequence after this audit

No new professional-tool domain should be added before these are completed:

1. **KiCad capability/version adapter** for board statistics and JSON report feature probes.
2. **Git porcelain status** contract.
3. **Provider provenance** metadata/warnings, beginning with OpenOCD dirty/non-release builds.
4. **Antigravity structured-success validation**.
5. **systemd journal degraded-state normalization**.
6. **dependency install-script allowlist/CI gate**.
7. **CMSIS-SVD inheritance-resolution semantics** before live register introspection.
8. **ROS2 native compatibility/live acceptance matrix** before high-rate/performance claims.

After these gates pass, the next safe expansion may proceed toward deeper STM32/RTOS inspection, richer version-adapted KiCad diagnostics, and additional Office validation. Mutation authority must not expand merely because richer metadata becomes available.

## 9. Overall conclusion

RWMCP v0.45.0 is **not relying on one monolithic trust assumption**. Its strongest capabilities derive reliability from fixed machine interfaces, bounded typed adapters, owner policy, Work Session/resource ownership, fail-closed parsing, release checksums and cross-platform CI.

The current platform is suitable as a production baseline **with constraints explicitly attached to moving/vendor-dependent providers**.

There is no evidence supporting a wholesale rewrite. The correct next action is targeted hardening of the concrete gaps above, followed by another regression/release gate before adding broader professional-tool authority.

## 10. Audit hardening closure

The priority reliability gaps identified above were implemented on the isolated audit worktree before any new professional-tool expansion:

- KiCad now probes optional `pcb export stats` / BOM capabilities and degrades diagnostics when board statistics are unavailable instead of failing the entire diagnostic bundle.
- Git status now uses the documented `--porcelain=v2 --branch` machine contract; WorktreeManager clean/dirty detection was updated to consume porcelain-v2 headers correctly.
- OpenOCD provider status now distinguishes release, development, dirty-development and unknown provenance. A `-dirty` build remains usable but no longer receives the same provenance confidence as a clean release build.
- Antigravity dispatch rejects a suspicious empty `SUCCESS` when no response, tool/subagent activity, token usage or Git-observable work exists.
- systemd journal collection now reports an explicit `ok` versus `degraded` state instead of equating executable availability with successful collection.
- dependency install-script-bearing packages are explicitly enumerated and checked by `npm run supply-chain:validate`; CI and prepack fail when the discovered set diverges from policy.
- CMSIS-SVD inspection now exposes `inheritance.derivedFromPresent` and `inheritance.resolved`; unresolved inheritance is explicitly unsuitable as authoritative live-register-write metadata.

Acceptance after these changes:

- `npm run supply-chain:validate` — PASS (4 discovered install-script packages, 4 explicit policy entries);
- `npm test` — 597 total / 595 PASS / 0 FAIL / 2 SKIP;
- `npm run typecheck` — PASS;
- `npm run build` — PASS;
- `npm run plugin:validate` — PASS;
- `git diff --check` — PASS.

This closes the audit's immediate P0/P1/P2 hardening list without widening public execution authority. The next phase may study upstream patterns and add improvements only where they preserve the trust boundaries documented above.

