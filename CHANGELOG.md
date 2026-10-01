# Changelog

This file records shipped RWMCP release milestones. Future work belongs in `docs/ROADMAP.md`.

## Unreleased — v0.67.0 development

- Development identity is `0.67.0-dev.0` on `channel=development`; the production/stable release remains v0.66.0.
- Post-v0.66 extensions now include CANopen, generic MQTT observation, Modbus TCP, OPC UA, camera/RTSP/ONVIF PTZ, industrial endpoint profiles, and media/ComfyUI workflows.
- Runtime capability-readiness reporting distinguishes implemented contracts from provider/node readiness without widening authority.
- Media/Video Phase 4 promotes owner-local typed Remotion presets into plan/render tools with project-local CLI execution, local browser reuse, fail-if-exists MP4 output, temporary-props cleanup and SHA-256 artifact evidence.
- Media/Video Phase 5 adds extension-owned Engineering Workflow contributions plus `media.remotion.render_accept` and `media.comfyui.generate_import_accept`, preserving the generic workflow envelope, explicit Work Session mutation ownership, bounded polling and FFprobe acceptance evidence without adding top-level MCP authority.
- Camera Diagnostics Phase 3 adds bounded concurrent fleet health probing for up to 32 owner-local camera profiles with per-camera RTSP/media evidence and p50/p95 latency aggregation, without camera mutation.
- Whole-project hardening adds CI-enforced reusable-tool/unique-tool/public-template architecture gates, strict unused-code compiler checks, and a high-confidence tracked-secret scan wired into `verify`, `prepack`, CI and release. It also extracts the engineering workflow catalog/parameter contract from the large workflow engine, refreshes MCP SDK/dev dependencies within existing semver ranges, removes 13 unreferenced historical screenshots, losslessly recompresses Moonlight PNG backgrounds, and ships only compiled runtime JavaScript from `dist` so declarations/source maps stay development-only. The packed release falls from 29,100,295 bytes / 877 entries to 26,768,582 bytes / 433 entries without changing runtime behavior.
- Engineering-workbench reuse hardening removes unreleased project-specific MQTT/AGV semantics from core. `mqtt_json_observe` performs bounded profile/topic-driven JSON property observation, and Industrial Endpoint Profiles use generic `mqtt-topic` descriptors. Device/product-specific topic conventions remain external project/profile data.
- CANopen Phase 3 adds one generic read-only `canopen_capture_analyze` surface backed by a transport-agnostic pure analysis engine: node inventory/NMT transitions, bounded SDO initiate exchange correlation, PDO/SYNC/Heartbeat cadence and jitter/gap evidence, and protocol issue summaries. Optional EDS/DCF semantics refine configured COB-IDs; no project-specific device logic is embedded and observed gaps are not labeled timeouts without explicit timeout configuration.
- CANopen Phase 2 adds cross-platform bounded EDS/DCF Object Dictionary inspection, exact lookup and communication-profile summaries with strict `$NODEID +/- literal` resolution from explicit node IDs or DCF commissioning metadata. Where Linux SocketCAN is ready, passive captures add configured/default SDO/PDO COB-ID semantics, expedited SDO values, SDO command/abort classification, EMCY error-register interpretation, SYNC/TIME decoding and DLC conformance evidence. Unsupported or unresolved semantics retain raw evidence; all Phase 2 tools remain `workstation.read` and never transmit CAN frames.
- Action Schema is 51; Engineering API remains 5.
- These changes are unreleased and must pass the v0.67 acceptance matrix before release promotion.

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
