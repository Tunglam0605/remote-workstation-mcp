# Changelog

This file records shipped RWMCP release milestones. Future work belongs in `docs/ROADMAP.md`.

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
