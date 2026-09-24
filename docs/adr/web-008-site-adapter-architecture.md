# ADR-WEB-008: Site Adapter Architecture

Status: Accepted for architecture; adapter implementation deferred
Date: 2026-09-24

## Decision

Site adapters consume the generic typed browser core and contain site-specific semantics.

```
ChatGPT
  -> RWMCP typed Web API
  -> generic Browser Core
  -> Site Adapter (NotebookLM, GitHub, ...)
  -> provider
```

NotebookLM is not embedded into browser session, selector or provider classes.

Adapters expose high-level operations only when they can define meaningful postconditions. A successful click is never sufficient evidence for a successful site operation.

Example: adding a NotebookLM source succeeds only after the source is observed in the source inventory.

If a stable official API exists for an operation, the adapter should prefer it over brittle UI automation.
