# Approved Moonlight backend integration

## Scope and evidence

This document records the initial backend integration phase, based on source version 0.30.0. The current release requirements are in `release-spec.md`, which supersedes the initial local-preview scope.

Keep the approved Overview geometry, typography, effects, artwork and responsive rules. Use an isolated candidate checkout and preserve the managed installation while validating changes.

## Architecture and ownership

Use static vanilla modules in assets/moonlight. Preserve style.css and artwork byte-for-byte. setupHtml renders index.html with per-server in-memory setup token injection. Serve only allowlisted assets; same-origin CSP, loopback and token checks remain. No legacy UI as visual template.

- api.js: createApi(token) -> { request(path,{method='GET',body,signal,timeoutMs}={}) }, errors throw Error, no secrets stored/logged.
- store.js: createStore(api) -> { getState(), subscribe(callback), refresh(keys?), start(), stop() }. State is resource map for status,runtime,execution,antigravity,pairing,multiNode,permissions,updates,admin,console. Every resource {data,error,loading,loadedAt}; error invalidates stale data. Subscriber gets map. Reuse existing routes; console resource optional pending execution adapter contract.
- model.js: deriveCards(resources), deriveNotifications(resources), deriveMetrics(resources), deriveActivities(resources). Cards {id,name,type,status,tone,description,specs:[{icon,label,value}],source}. First cards actual local host/runtime/tunnel, Codex, Antigravity, health; insert actual paired nodes only, no invented devices. Unknown values em dash. Notifications derived only from true backend state; no fake historical messages.
- app.js: token bootstrap, store subscription, exact overview render, navigation to real views, accessible dialog, clock/countdown, saved nonsecret appearance preferences, safe text rendering, console UI adapter.
- views.js: createViews({api,store,openModal,openPage,toast,refresh}) -> {open(page),openDevice(card),openNotifications(),openProfile()}. Own actual forms/views for Access, Execution, Devices, Updates, Settings. Reuse exact endpoint contracts in backend-api-inventory.md. openModal(title,htmlOrElement) returns modal content element; direct event binding scoped there. Mutation actions explicit with confirmation for production impact, backend remains authority. No secrets persisted/logged/query strings. Support existing first-run, recovery, UAC/admin, permissions, pairing, multi-node grants, updater and execution policy forms without losing existing UI capabilities.
- integration.css: appended additions only for secondary forms/status. Do not change approved style.css.
- Backend execution bridge: only if no existing browser-auth-compatible route; reuse bounded backend policy, work-session, typed adapters, configured capabilities; never arbitrary shell or private token extraction. Preserve authenticated MCP surface unchanged.

## Verification gates

1. API/model unit tests: unavailable/stale/auth errors, no fake telemetry, real pairing and provider state; mutation response/errors.
2. Setup HTTP security/integration tests: loopback origin, missing/wrong token, no token URL/storage/logs, assets path allowlist/CSP, owner action refusal, policy denial, work-session ownership, safe permitted execution.
3. Browser QA: actual backend preview separate port (4174), desktop 1672x941 and1920x1080, mobile widths. Compare approved screenshots and element rectangles. No UI old template. Real resources inspected without mutating production during tests.
4. Full npm typecheck/test/build/plugin:validate, maintain unrelated backend capabilities.
5. Retain local worktree + running preview, open browser and deliver URL, connected components and telemetry gaps. Completion requires every user requirement supported by current evidence.

## Final implementation

Verified evidence and limitations are in `acceptance.md`. The safe owner bridge is `GET/POST /api/execution`, with typed operations `session-create`, `git-status`, `task-run`, `process-read`, and `process-stop`. Only local node identity and bounded, PathGuard-validated immediate Git/worktree project choices are accepted. Task catalog contains names only; process responses omit command arguments. Fresh permission scopes and policy apply per operation; closed/closing/expired/foreign sessions are denied. Dedicated session/audit files are namespaced by Control Center port. Completed process output is bounded and retained briefly; shutdown stops only bridge-owned processes. No MCP bearer extraction, createContext, remote fallback, or production reconciliation is involved.

Preview :4174 loads the isolated candidate server/assets and controls the existing managed v0.30.0 runtime through its original scripts and configuration. The approved :4173 remains independent. No release or merge was performed.
