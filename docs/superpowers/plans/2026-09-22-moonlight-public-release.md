# Moonlight public release Implementation Plan

> **For agentic workers:** Use subagent-driven-development to implement independent owned scopes, review changes and verify each deliverable.

**Goal:** Complete a polished Vietnamese-first bilingual Moonlight Control Center and publish a validated release using the repository's existing channel.

**Architecture:** Keep vanilla frontend and existing authenticated owner APIs. Add a small dictionary locale module and dedicated secondary page outlet; all themes and Overview remain shared. Preserve current execution security and separate preview from managed production runtime.

**Tech Stack:** TypeScript Node HTTP server, vanilla JS/CSS, node:test, browser UI testing, existing release workflow.

**Spec:** `docs/moonlight/release-spec.md`.

## Work

- [ ] Read release workflows, branch/remote state and packaging scripts; identify actual release channel and version strategy.
- [ ] Implement pure locale core with validated preference/fallback/placeholder behavior and tests.
- [ ] Shell agent: translate shell/Overview/console/themes, language toggle, secondary page outlet, retain layout and locale persistence.
- [ ] Views agent: full-page layout and complete Vietnamese/English forms, confirmations, toasts and error handling.
- [ ] Audit agent: compare owner routes to frontend functionality, identify missing or misleading controls and security gaps; remedy bounded findings.
- [ ] Integrate module/static allowlists and reconcile interfaces; verify all 10 themes, locale switching, secondary pages, mobile, console, safe error states and no secret persistence.
- [ ] Run typecheck, focused/full tests, build, plugin validation, package smoke/install checks and inspect packed contents.
- [ ] Review final diff/security and update release documentation/version consistently.
- [ ] Publish via existing channel after verification; validate public artifact/checksums and report URL/version. Do not silently install or restart the user's managed runtime; rollout only if separately requested.
