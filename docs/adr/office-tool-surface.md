# ADR: Office Tool Surface

Status: Accepted for Phase A
Date: 2026-09-23

## Context

The Windows RWMCP connector currently exposes 141 tools. Mirroring every Word/Excel/PowerPoint method would cause tool/context explosion and make safe selection harder.

## Decision

Use progressive disclosure plus typed bounded batch operations.

Initial planned surface:

- `office_capabilities`
- `office_session_open`
- `office_session_status`
- `office_session_close`
- `word_inspect`
- `word_edit`
- `word_equation`
- `word_table`
- `word_media`
- `word_render`
- `word_validate`

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

Office tools are additive. Existing tool names/semantics do not change. Optional Office backends must not make Linux startup fail.

## Rejected alternatives

- one tool per font/size/color/indent/spacing property;
- `office_execute_script`;
- raw VBA/Python/shell/COM method invocation;
- untyped `office_do_anything`.
