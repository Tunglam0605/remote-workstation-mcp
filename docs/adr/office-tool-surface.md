# ADR: Office Tool Surface

Status: Accepted and implemented for Word v0.33.2
Date: 2026-09-23

## Context

The Windows RWMCP connector currently exposes 141 tools. Mirroring every Word/Excel/PowerPoint method would cause tool/context explosion and make safe selection harder.

## Decision

Use progressive disclosure plus typed bounded batch operations.

Implemented v0.33.2 surface:

- `office_capabilities` - progressive discovery and backend/security posture;
- `word_inspect` - bounded structural Word AST;
- `word_edit` - discriminated `apply|rollback` action with typed batched operations and acceptance requirements.

Separate `word_equation`, `word_table`, `word_media`, `word_render`, session-management and validation tools were intentionally not registered because their current semantics fit inside inspection or the transactional edit contract. They may be introduced later only when they provide a distinct capability boundary rather than a convenience wrapper.

Excel and PowerPoint domain tools are not registered until their phases begin.

## Typed batch rule

`word_edit.operations[]` is a discriminated union. Each operation has:

- a known operation type;
- typed locator;
- bounded parameters;
- explicit mutation scope;
- backend capability requirements;
- validation constraints.

There is no arbitrary code, raw command, VBA or COM-method field.

## Discovery

`office_capabilities` reports:

- Office Pack/API version;
- domains currently implemented;
- installed/available backends;
- per-backend capability matrix;
- native Office availability if probed;
- render/export support;
- risky features disabled by policy.

## Compatibility

Office tools are additive on Windows only. Existing non-Office tool names/semantics do not change. Linux/macOS nodes register no Office MCP tools and must remain healthy without Microsoft Office dependencies.

## Rejected alternatives

- one tool per font/size/color/indent/spacing property;
- `office_execute_script`;
- raw VBA/Python/shell/COM method invocation;
- untyped `office_do_anything`.
