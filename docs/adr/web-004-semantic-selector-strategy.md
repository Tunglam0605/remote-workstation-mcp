# ADR-WEB-004: Semantic Selector Strategy

Status: Accepted for Phase A/B
Date: 2026-09-24

## Decision

Selector priority is:

1. accessibility role + accessible name;
2. stable test/data attribute;
3. associated label;
4. stable DOM attribute;
5. visible text;
6. bounded CSS fallback;
7. visual recognition;
8. physical coordinates.

Playwright locator strictness/actionability is reused rather than bypassed.

`browser_inspect` returns bounded page semantics, not raw HTML. Element references are RWMCP-generated, session-scoped and generation-scoped. Future mutation tools resolve the stored semantic locator again and revalidate visibility/state before acting.

Absolute XPath and positional selectors such as `nth-child(17)` are not generated as normal references.

## Phase B

Read-only inspection may use Playwright ARIA snapshot JSON plus normalized interactive-element descriptors. No public API accepts arbitrary selectors in Phase B.
