# ADR-WEB-006: Work Session Integration

Status: Accepted for Phase A/B
Date: 2026-09-24

## Decision

Web Automation reuses existing RWMCP principal + Work Session execution context. It does not create a second auth/session framework.

A browser session is caller-owned and Work-Session-owned. Phase B requires an explicit Work Session for session creation and operates subsequent calls inside the same Work Session.

Resource key vocabulary reserved for later concurrency integration:
- `browser-profile:<profile>`
- `browser-session:<id>`
- `browser-tab:<session>:<tab>`

Phase F will persist browser metadata into resumable Work Session state and reconcile actual provider/process state after restart.

## Rejected

- Global shared browser singleton with no owner.
- Treating a browser session id as an authorization credential.
- Auto-resuming a browser without verifying the real process/context.
