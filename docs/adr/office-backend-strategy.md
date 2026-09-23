# ADR: Office Backend Strategy

Status: Accepted for Phase A
Date: 2026-09-23

## Decision

Office uses a capability-aware multi-backend model:

1. **Native COM** — Windows-only, highest fidelity for real Office application semantics.
2. **OOXML/headless** — deterministic inspection and supported package mutations.
3. **UI automation** — optional later fallback only for operations not exposed through supported APIs.

Backend choice is per requested operation/capability, not one global preferred-engine switch.

## Rules

- Every backend advertises explicit capabilities.
- A tool requests required capabilities and the selector returns only a backend that satisfies them.
- There is no silent semantic downgrade.
- Native-required operations fail closed if Word/Excel/PowerPoint native automation is unavailable.
- COM imports/processes are lazy and optional; Linux startup must never depend on them.
- Raw COM dispatch objects/method names are never exposed through MCP arguments.
- UI automation is never selected implicitly.
- Mutating native workflows use an RWMCP-owned isolated Office instance by default.
- Attaching to a user's existing Office process is a separate explicit capability requiring document identity verification.

## Domain examples

Word:
- package/media/relationship inspection -> OOXML;
- supported deterministic text/table edit -> OOXML;
- Track Changes, native OMath verification, Word open/PDF export -> COM.

Excel:
- deterministic package/range/style edit -> OOXML when fidelity permits;
- recalculation/evaluated formulas/live workbook behavior -> COM.

PowerPoint:
- structural slide/shape edit -> OOXML when supported;
- native layout/render validation -> COM.

## Rejected alternatives

- COM-only.
- OOXML-only.
- Office.js as the default local engine.
- automatic UI fallback.
