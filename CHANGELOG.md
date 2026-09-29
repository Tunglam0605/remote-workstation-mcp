# Changelog

This file records shipped RWMCP release milestones. Future work belongs in `docs/ROADMAP.md`.

## Unreleased — v0.67.0 development

- Development identity is `0.67.0-dev.0` on `channel=development`; the production/stable release remains v0.66.0.
- Post-v0.66 extensions now include CANopen, MQTT/AGV observation, Modbus TCP, OPC UA, camera/RTSP/ONVIF PTZ, industrial endpoint profiles, and media/ComfyUI workflows.
- Runtime capability-readiness reporting distinguishes implemented contracts from provider/node readiness without widening authority.
- Media/Video Phase 4 promotes owner-local typed Remotion presets into plan/render tools with project-local CLI execution, local browser reuse, fail-if-exists MP4 output, temporary-props cleanup and SHA-256 artifact evidence.
- Camera Diagnostics Phase 3 adds bounded concurrent fleet health probing for up to 32 owner-local camera profiles with per-camera RTSP/media evidence and p50/p95 latency aggregation, without camera mutation.
- Action Schema is 48; Engineering API remains 5.
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
