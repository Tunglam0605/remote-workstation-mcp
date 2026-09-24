# ADR-WEB-001: Browser Provider Architecture

Status: Accepted for Phase A/B
Date: 2026-09-24

## Context

RWMCP needs deterministic browser execution without turning the MCP surface into a raw browser scripting API.

## Decision

Web Automation is a sibling capability pack:

```
RWMCP
├── Core
├── Engineering
├── Office
├── Web Automation
└── Agent / Worker Orchestration
```

The first provider is Playwright over Chromium-family browsers. Playwright is behind an internal `BrowserProvider` contract. CDP may be used internally for capabilities Playwright does not model well, but raw CDP methods are not MCP arguments.

Phase B supports managed browser sessions only:
- `background` — default; headless managed browser.
- `visible` — same workflow semantics, visible window for debug/acceptance.

Existing Chrome and desktop control are explicitly deferred.

## Provider contract

The provider owns browser-specific mechanics for launch, close, tabs, navigation, semantic inspection, extraction and screenshots. Core owns policy, ownership, lifecycle, bounded results and error normalization.

## Rejected

- Raw Playwright objects exposed through MCP.
- `browser_eval_js`.
- Coordinate-driven mouse automation as primary control.
- NotebookLM-specific logic in the provider.
