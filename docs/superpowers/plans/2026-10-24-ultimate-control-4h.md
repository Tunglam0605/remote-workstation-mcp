# Ultimate Control 4H Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Owner-local, non-renewable four-hour authorization for exact automated workflows, not unrestricted OS elevation.

**Architecture:** Separate consent from `PermissionMode` and legacy leases. Control Center activates an atomically stored, principal/node/runtime-epoch-bound consent; RWMCP validates it on every opted-in workflow transition. Restart creates a new runtime epoch, invalidating old consent. Existing MCP tools keep existing authorization.

**Tech Stack:** TypeScript 6, Node.js >=22, Zod, Node test runner/tsx, RWMCP Control Center, PolicyEngine.

**Spec:** `docs/superpowers/specs/2026-10-24-ultimate-control-4h-multinode-design.md`

## Global Constraints

- Start from Windows release tag v0.71.0, not divergent `main`. Work only in an isolated development branch.
- Windows-only feature, Ubuntu frozen. No machine deployments or owner-policy changes in this plan.
- Ultimate is not root/Admin, a new higher `PermissionMode`, general shell authority, or bypass of ChatGPT approvals.
- Only owner-local UI can activate/revoke. Normal MCP requests cannot extend, create or widen grants.
- Exactly 30/60/120/240-minute choices; hard maximum 4h; no silent renewal.
- Effective authority = authenticated principal AND local policy AND allowed workflow/paths/profiles/grants AND active consent.
- Revocation, expiry and runtime restart fail closed. Persistent `configuredMode=full_control` remains explicitly visible after Ultimate expires.
- New automated workflow gateway is opt-in; existing manually invoked MCP tools remain governed by their own independent authorization.

## Review Focus

1. Clock rollback and elapsed-time manipulation must never extend 4h — Task 1.
2. Corrupt owner state, interrupted atomic save and runtime restart fail closed — Task 1.
3. Shared tunnel principal/sibling Work Session cannot silently widen selected scope — Task 2.
4. Non-loopback Host/Origin or invalid setup-token cannot activate — Task 3.
5. Permanent Full Access is accurately disclosed after Ultimate expiry — Task 4.

---

### Task 1: Consent Domain and Runtime Epoch

**Files:**
- Create: `src/security/ultimate-consent.ts`, `src/security/ultimate-runtime-epoch.ts`
- Test: `tests/ultimate-consent.test.ts`

**Interfaces:**
- `type UltimateOperation = 'build' | 'test' | 'workspace_add' | 'transfer' | 'artifact_verify'`
- `interface UltimateScope { operations: UltimateOperation[]; workspaces: string[]; profileIds: string[]; transferGrantIds: string[]; workSessionId?: string }`
- `interface UltimateActivation { nodeId: string; principalId: string; durationMinutes: 30|60|120|240; scope: UltimateScope }`
- `UltimateConsentManager.activate(input): Promise<UltimateStatus>`, `.status(): Promise<UltimateStatus>`, `.revoke(): Promise<void>`, `.assertAllowed(action: UltimateActionContext): Promise<void>`.
- `RuntimeEpoch`: unpredictable per-MCP-start ID saved atomically with owner-only permissions; Control Center activation binds to current epoch. Runtime rejects stale epochs after restart.

- [ ] **1.1 RED:** Test all four durations, invalid TTL, wrong node/principal, expired/rollback clock, mismatched runtime epoch, absent/corrupt record, and immediate revoke.
- [ ] **1.2 Verify RED:** `node --import tsx --test tests/ultimate-consent.test.ts` must fail for missing feature.
- [ ] **1.3 GREEN:** Implement smallest private atomic store and runtime-epoch helper; monotonic + absolute expiry, no renewal.
- [ ] **1.4 Verify GREEN:** Focused suite, `npm run typecheck`, and `npm test` pass.
- [ ] **1.5 Commit:** `feat(security): add bounded Ultimate consent and runtime epoch`.

### Task 2: Authenticated Opt-In Gateway

**Files:**
- Create: `src/security/ultimate-action-policy.ts`
- Modify: `src/context.ts`, `src/bootstrap/engineering-services.ts` only if dependency injection needs it.
- Test: `tests/ultimate-action-policy.test.ts`

**Interfaces:**
- `UltimateActionPolicy.assert(action: UltimateActionContext): Promise<void>` checks request principal, current local PolicyEngine, and exact consent operation/workspace/profile/grant.
- Never trust model-supplied `automatic=true`; only explicit future `platform.handoff_*` IDs call this gateway.

- [ ] **2.1 RED:** Approved exact scope passes; wrong scope, wrong principal, missing consent, sibling Work Session, denied local policy, Admin/root/raw shell/hardware fail.
- [ ] **2.2 Verify RED:** Focused test fails for the missing gateway.
- [ ] **2.3 GREEN:** Add minimal gateway and inject into runtime services without exposing activation secrets.
- [ ] **2.4 Verify GREEN:** Focused test, typecheck, full suite.
- [ ] **2.5 Commit:** `feat(security): bind automated consent to principal and local policy`.

### Task 3: Owner-Local Control Center API

**Files:**
- Create: `src/setup/ultimate-control.ts`
- Modify: `src/setup/setup-server.ts`
- Test: `tests/setup-ultimate-control.test.ts`

**Interfaces:**
- Existing loopback/Host/Origin/CSRF guard applies to `GET /api/ultimate`, `POST /api/ultimate/activate`, `DELETE /api/ultimate`.
- POST accepts exact approved scope/workspace/profile/grants and one of 30/60/120/240; never arbitrary command or argv.
- Status returns expiry, allowed categories, base mode warning; never bearer secret.

- [ ] **3.1 RED:** Invalid TTL/scope/body and wrong CSRF/origin/host denied; valid activation/revoke leaves existing `mode`/scopes unchanged.
- [ ] **3.2 Verify RED:** Focused test observes missing route/controller.
- [ ] **3.3 GREEN:** Add owner-only module and routes; reject invalid current runtime epoch.
- [ ] **3.4 Verify GREEN:** Focused tests plus `tests/setup-server.test.ts` and `tests/setup-permissions.test.ts`, then full suite.
- [ ] **3.5 Commit:** `feat(setup): add owner-local Ultimate controls`.

### Task 4: Control Center UI and Read-Only Status

**Files:**
- Modify: `assets/moonlight/system-access-views.js`, its companion API/state file only if needed, `src/tools/chatgpt-web-tools.ts` for read-only status.
- Test: `tests/moonlight-views.test.ts`, `tests/chatgpt-web-status.test.ts`.

**Interfaces:** Select 30m/1h/2h/4h, preview scope, activate/revoke, countdown, accurate permanent Full Access warning. ChatGPT status cannot create/renew consent.

- [ ] **4.1 RED:** DOM/JSON/status contracts for active/expired/revoked, controls and persistent base-Full-Access warning.
- [ ] **4.2 Verify RED:** Focused tests fail on missing UI/status.
- [ ] **4.3 GREEN:** Minimal UI and read-only integration, no Control Center redesign.
- [ ] **4.4 Verify GREEN:** Focused tests and `npm run verify` on compatible Windows acceptance runner.
- [ ] **4.5 Commit:** `feat(ui): show bounded Ultimate session`.

### Task 5: Documentation and Release Gate

**Files:** Update `docs/SECURITY.md`, `docs/OPERATIONS.md`, `README.md` only as necessary. Test Windows release/packaging contracts.

- [ ] **5.1 RED:** Add contract test proving Ultimate is not an MCP activation tool or Linux release feature.
- [ ] **5.2 Verify RED:** Confirm intended contract fails.
- [ ] **5.3 GREEN:** Document 4h behavior, emergency revoke, failure/restart, persistent Full Access, and separately managed ChatGPT app permissions.
- [ ] **5.4 Verify GREEN:** `npm run verify`, review diff and commit.

**Exit gate:** Windows disposable-runtime acceptance succeeds. No deployment or actual workstation policy change. Follow with `2026-10-24-multinode-project-handoff.md`.
