# Changelog

This file records shipped RWMCP release milestones. Future work belongs in `docs/ROADMAP.md`.

## 0.70.0-dev.8 — Owner Full Control managed updates and safe runtime handoff

- Adds dedicated authenticated MCP actions `update_install`, `update_install_status`, `update_restart`: only effective owner Full Control can stage a version-pinned official Windows development prerelease, review a durable update/rollback transaction and request a guarded runtime restart. No arbitrary shell, script-host or external update URL is introduced.
- Uses the existing persistent owner Control Center, exact CSRF + Origin checks, official GitHub release preflight and package SHA-256 verification, versioned slots and durable worker handoffs.
- Fixes the Windows safe-restart helper to read Moonlight's current CSRF meta tag rather than removed legacy inline JavaScript, and chooses the manifest-verified managed current slot instead of a stale old Control Center root.
- Validation: full Windows `npm run verify` passed (994 passing / 2 skipped / 0 failed of 996 tests); cross-platform CI and official tagged package acceptance still required before deployment.
- Development prerelease, opt-in per exact version. Full Control does not grant blanket automatic self-update or bypass owner lease, local CSRF, verified release/package, work-session interlocks or rollback gates.

## 0.70.0-dev.7 — KiCad fine-pitch routing and MCP attachment hardening

- Adds an offline MCP registration ledger and attachment reconciliation tooling, with platform-accurate capability filtering for Linux-only SocketCAN tools on Windows; does not bypass tool permissions, tunnel authentication or client connector attachment.
- Fixes KiCad schematic default placement to the 50-mil grid and preserves authoritative Datasheet/Description parity fields in generated PCB footprints.
- Improves two-layer KiCad route planning with net-aware existing-copper clearance, bounded A* search, corridor-first routing, fine-pitch adaptive grid selection and same-priority short-net ordering. Applied routes remain typed, SHA-bound, KiCad-DRC-gated and rollback-on-regression.
- Acceptance: Windows/Linux CI, KiCad 10.0.6 clean synthetic manufacturing package (including BOM/positions/STEP), and fail-closed rejection of an incomplete STM32F103 fixture. **Not** a claim of automatically completing a complex STM32 PCB; that fixture still has unconnected items and cannot be fabricated.
- Development prerelease only. No automatic workstation rollout or hardware/social account mutation.

## 0.70.0-dev.6 — Windows Administrator approval expiry hardening

- Fixes a real Windows Control Center failure mode: an Administrator request accepted by the owner but never started by the privileged helper no longer remains in `approved` forever. The existing five-minute TTL also expires unstarted approved requests.
- Preserves running and terminal states, blocks late execution of expired approvals, and adds three isolated regression cases (approved-stalled, already-running, unapproved-pending).
- Windows source validation before release: 970 tests (968 passed, 0 failed, 2 skipped); TypeScript typecheck passed; PR #243 passed Linux and Windows CI, including PTY soak and packaged runtime smoke. This release does not claim live KiCad/Gerber or Social scheduling acceptance.
- Maintains the owner-only Control Center explicit development release installer, checksum checks and rollback; does not bypass UAC or allow generic privileged shell execution.

## 0.68.0 — Reusable KiCad PCB Design Agent

- Promotes KiCad PCB Design Agent Phases 7–17 into the stable release: typed design/visual review, geometry-based layout optimization planning, constraints/DFM review, installed-library intelligence, fail-if-exists schematic synthesis, manifest-SHA PCB synthesis, STM32 pin planning, semantic placement, bounded routing orchestration, electrical review and manufacturing-package gating.
- Hardens dense-MCU/fine-pitch behavior with package-pin-aware placement, correct KiCad clockwise board rotation handling, preserved MCU no-connect parity, foreign-net-pad avoidance, route-to-route clearance accounting, deterministic route-operation de-duplication and typed ground-net routing precedence.
- Adds a focused STM32F407VET6 LQFP100 0.5 mm USB_DM/USB_DP acceptance path that composes pin-aware placement → board synthesis → routing → route application → electrical review. The pair routes without vias or high/review findings; controlled-impedance verification remains correctly reported as requiring a specialized solver.
- Preserves fail-closed authority boundaries: routing stays bounded and typed, manufacturing output is emitted only after clean validation gates, and the agent cannot claim SI/EMI/thermal or controlled-impedance certification without authoritative external evidence.
- Release acceptance on 2026-10-07: local npm run verify passed with 879 tests passed, 0 failed and 2 environment-dependent skips; PR #221 passed Linux and Windows CI; the merge commit also passed Linux and Windows CI. No physical PCB or hardware was modified during framework acceptance.

## 0.67.1 — Secure Tunnel Extension Lifecycle Hotfix

- Fixes the live ChatGPT `internal error` regression introduced by v0.67 extension-owned workflow contributions. Streamable HTTP may build a fresh MCP server for successive requests while reusing one `AppContext`; extension `initialize(ctx)` now runs once per context, while `register(server, ctx)` remains per-server. Media workflow contributions therefore bootstrap once and no longer fail later `tools/call` requests with duplicate workflow IDs.
- Aligns Windows OpenAI runtime identity with the canonical `openai-secure-mcp-tunnel` client type while retaining the legacy `chatgpt` label as a compatibility alias for extension-surface resolution.
- Keeps newly expanded v0.67 extension families behind the baseline OpenAI tool surface unless `RWMCP_OPENAI_TOOL_SURFACE=full` is explicitly selected, and keeps extension-specific media parameters out of the stable Work Objective core schema.
- Acceptance on 2026-10-05: full `npm run verify` passed; guarded Windows A/B validation reached the real OpenAI Secure MCP Tunnel, returned HTTP 200 for `chatgpt_web_status`, `workstation_identity` and `workspace_list`, recorded `CONFIRMED_AND_ROLLED_BACK`, and restored v0.66.0 automatically after the test window.

## 0.67.0 — Engineering Workbench Expansion & Hardening

- Stable identity is `0.67.0` on `channel=stable`; promoted on 2026-10-01 after the full Linux/Windows acceptance matrix passed.
- Post-v0.66 extensions now include CANopen, generic MQTT observation, Modbus TCP, OPC UA, camera/RTSP/ONVIF PTZ, industrial endpoint profiles, and media/ComfyUI workflows.
- Runtime capability-readiness reporting distinguishes implemented contracts from provider/node readiness without widening authority.
- Media/Video Phase 4 promotes owner-local typed Remotion presets into plan/render tools with project-local CLI execution, local browser reuse, fail-if-exists MP4 output, temporary-props cleanup and SHA-256 artifact evidence.
- Media/Video Phase 5 adds extension-owned Engineering Workflow contributions plus `media.remotion.render_accept` and `media.comfyui.generate_import_accept`, preserving the generic workflow envelope, explicit Work Session mutation ownership, bounded polling and FFprobe acceptance evidence without adding top-level MCP authority.
- Camera Diagnostics Phase 3 adds bounded concurrent fleet health probing for up to 32 owner-local camera profiles with per-camera RTSP/media evidence and p50/p95 latency aggregation, without camera mutation.
- Whole-project hardening adds CI-enforced reusable-tool/unique-tool/public-template architecture gates, strict unused-code compiler checks, and a high-confidence tracked-secret scan wired into `verify`, `prepack`, CI and release. It also extracts the engineering workflow catalog/parameter contract from the large workflow engine, refreshes MCP SDK/dev dependencies within existing semver ranges, removes 13 unreferenced historical screenshots, losslessly recompresses Moonlight PNG backgrounds, and ships only compiled runtime JavaScript from `dist` so declarations/source maps stay development-only. The packed release falls from 29,100,295 bytes / 877 entries to 26,767,942 bytes / 432 entries without changing runtime behavior.
- Engineering-workbench reuse hardening removes unreleased project-specific MQTT/AGV semantics from core. `mqtt_json_observe` performs bounded profile/topic-driven JSON property observation, and Industrial Endpoint Profiles use generic `mqtt-topic` descriptors. Device/product-specific topic conventions remain external project/profile data.
- CANopen Phase 3 adds one generic read-only `canopen_capture_analyze` surface backed by a transport-agnostic pure analysis engine: node inventory/NMT transitions, bounded SDO initiate exchange correlation, PDO/SYNC/Heartbeat cadence and jitter/gap evidence, and protocol issue summaries. Optional EDS/DCF semantics refine configured COB-IDs; no project-specific device logic is embedded and observed gaps are not labeled timeouts without explicit timeout configuration.
- CANopen Phase 2 adds cross-platform bounded EDS/DCF Object Dictionary inspection, exact lookup and communication-profile summaries with strict `$NODEID +/- literal` resolution from explicit node IDs or DCF commissioning metadata. Where Linux SocketCAN is ready, passive captures add configured/default SDO/PDO COB-ID semantics, expedited SDO values, SDO command/abort classification, EMCY error-register interpretation, SYNC/TIME decoding and DLC conformance evidence. Unsupported or unresolved semantics retain raw evidence; all Phase 2 tools remain `workstation.read` and never transmit CAN frames.
- Action Schema is 51; Engineering API remains 5.
- Release acceptance: full Linux and Windows CI passed, including packed-runtime smoke, PTY/ConPTY lifecycle, update/recovery lifecycle, architecture/security gates and production dependency audit.

## 0.66.0 — Architecture Consolidation

### Architecture
- Added a typed Extension Registry with stable extension identifiers, kinds, versions and platform gates.
- Established CI-enforced one-way architecture boundaries and documented the long-term Platform / Engineering Framework / Extensions / Orchestration / MCP structure.
- Moved CAN, Modbus RTU, ROS 2, STM32, ESP32 and KiCad MCP handlers behind domain extensions while preserving public tool names and schemas.
- Modularized generic engineering network, serial and terminal MCP families.
- Split engineering and web construction out of the central AppContext into bootstrap factories.

### Moonlight Control Center
- Split shared view primitives and capability-driven Work, Engineering, Office and Web pages out of the central view module.
- Split System, Access and Execution page ownership into dedicated modules.
- Preserved navigation, backend APIs, execution-policy payloads, owner controls and seasonal theme behavior.

### Release governance
- Consolidated publication onto one canonical release workflow.
- Added architecture-boundary validation to CI/release gates.
- Separated shipped history from the forward roadmap.

### Compatibility
- Action Schema: 36.
- Engineering API: 5.
- Public MCP action/schema contracts remain compatible with v0.65.x.
- Existing Direct Node, Work Session, permission, hardware-interlock, update and rollback authority remains unchanged.

## 0.65.2

Moonlight seasonal/event scheduling, session-only manual theme overrides, event countdown behavior, palette cleanup and removal of the redundant Quick Overview block.

For older release details, see the GitHub Releases history.
