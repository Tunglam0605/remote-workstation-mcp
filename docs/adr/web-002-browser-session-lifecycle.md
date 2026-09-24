# ADR-WEB-002: Browser Session Lifecycle

Status: Accepted for Phase A/B
Date: 2026-09-24

## Decision

Every managed browser session is owned by one authenticated principal plus one explicit Work Session.

Phase B lifecycle:
1. create under an explicit Work Session;
2. launch a managed browser in background or visible mode;
3. allocate stable RWMCP session/tab ids;
4. navigate only through domain policy;
5. inspect/extract using bounded semantic output;
6. close explicitly or during runtime shutdown.

Phase B session state is process-local and reports `recoverable: false`. Durable resume/reconciliation is Phase F and must not falsely claim a dead browser survived an RWMCP restart.

Page mutation increments a page generation. Short-lived element references are invalidated when generation changes.

## Failure behavior

Browser exit/crash marks the session unavailable. A stale id returns a typed not-found/session-closed error rather than silently launching a replacement.
