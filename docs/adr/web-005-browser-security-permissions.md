# ADR-WEB-005: Browser Security and Permissions

Status: Accepted for Phase A/B
Date: 2026-09-24

## Decision

Web Automation is default-deny.

Owner settings will ultimately control:
- enabled/disabled;
- managed browser mode;
- allowed domains;
- upload/download permission;
- visual fallback permission;
- physical input permission.

Unknown domains are denied. Every navigation and redirect target is re-evaluated. The initial Phase B core accepts an injected bounded domain policy for tests and keeps production enablement conservative until Control Center settings are implemented.

Risk classes:
- READ: inspect, extract, screenshot;
- EXECUTE/ordinary browser state: create/close session, navigate/tab operations;
- WRITE: fill/type/select/upload/ordinary submit;
- HIGH RISK: public publish/send, delete, purchase/payment, account/security/permission/credential changes.

High-risk operations must never be represented as a generic click permission.

## Explicit exclusions

- arbitrary JavaScript execution;
- raw CDP command surface;
- raw cookie/token access;
- automatic cross-domain trust;
- implicit physical mouse/keyboard fallback.
