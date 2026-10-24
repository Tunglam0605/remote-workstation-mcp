# RWMCP Ultimate Control 4H & Multi-Node Project Handoff — Design v1.0

- Date: 2026-10-24
- Status: PROPOSED — OWNER APPROVAL REQUIRED BEFORE IMPLEMENTATION
- Owner decision: Approach A — bounded automatic execution of pre-authorized typed tasks, not unrestricted administrator/root automation.
- Repository: Tunglam0605/remote-workstation-mcp
- Design baseline: Windows release tag `v0.71.0`; reconcile divergent `main` before implementation. This document branch is based on the release tag only for review.

## 1. Intent and decisions

Make authenticated ChatGPT-driven engineering work across multiple RWMCP Direct Nodes less interruptive: one owner-local activation lasts at most four hours, permits predefined safe operations, and coordinates source/build-artifact transfer across approved machines. Example: Ubuntu SSD packages an STM32 project, Windows laptop compiles with its installed toolchain, then verified firmware artifacts return to Ubuntu SSD for an independently gated flashing step.

The owner selected Approach A. Alternative B (broad automatic execution including destructive operations or privilege escalation) was rejected for this phase. Alternative "unrestricted peer SSH / shared superuser credentials" was rejected because it violates Direct Node isolation, bilateral file grants, and current product charter.

**Not a promise:** RWMCP cannot suppress ChatGPT-hosted approval screens, overwrite app/workspace policy, bypass Windows UAC, or evade OS/tool sandbox approvals. ChatGPT may offer per-app "Allow all actions" but may still confirm or block sensitive calls (official OpenAI app permissions: https://help.openai.com/en/articles/20001495-managing-app-permissions-in-chatgpt).

## 2. Verified baseline / hard constraints

- Laptop Windows: RWMCP `v0.71.0` stable, node ID `dev_bc0577bc4af5e01c1e49b6fa`, workspaces `projects`, `stm32`.
- Ubuntu SSD: `v0.67.2-ubuntu.1`, node ID `dev_01871dcfdcbabe9205fca960`, workspace `projects`.
- Ubuntu Vision: `v0.66.0`, node ID `dev_7d2aa1ffc738f140bbfa6ef8`, workspace `projects`. Do not alter production vision services during design/initial rollout.
- Ubuntu Personal PC was offline at inspection; no version assumption.
- On inspected online nodes: effective `full_control`; `crossNodeTransfer=false`, `multiNode.enabled=false`, `configuredGrantCount=0`.
- Current Windows principal: `openai-tunnel` with read/write/execute/admin_request/full_control scopes; no dedicated cross-node scope.
- Current data-plane offers up to 512 MiB direct transfer over reachable private/Tailscale addresses, and up to 32 MiB relay through authenticated MCP tunnels (64 KiB chunks). Direct connectivity between nodes is NOT established just because both nodes are individually online.
- GitHub `main` reports v0.70.0-dev.10, while official v0.71.0 release is 20 commits ahead of the shared ancestor and diverged from `main`. Do not implement/merge against old `main` without reconciling release history.
- The 2026-10-11 platform policy freezes Linux/Ubuntu feature development and deployment. Initial work is Windows-only plus **existing** compatible Linux functionality. Reopening Linux development requires a separate explicit owner decision.

Canonical references: `src/policy.ts`, `src/permissions.ts`, `src/security/multi-node-authorization.ts`, `src/adapters/data-plane.ts`, `src/adapters/control-plane-relay.ts`, `src/setup/permissions.ts`, `src/setup/multi-node.ts`, `docs/DATA_PLANE.md`, `docs/PROJECT_CHARTER.md`, `docs/PLATFORM_SUPPORT_POLICY.md`.

## 3. Architectural principle

Ultimate Control is **a time-bounded automatic-action consent session**, NOT a new `PermissionMode` rank above `full_control`, NOT an admin/root token, and NOT permission to mutate peer nodes. Its effective set is the intersection of:

`authenticated principal scopes ∩ current local policy ∩ named typed-operation allowlist ∩ local Ultimate session constraints ∩ bilateral directional transfer grants (for transfer only)`.

A Work Session ID is an attribution/ownership handle, not authorization.

### Components / ownership

| Module (proposed) | Single responsibility |
|---|---|
| `UltimateConsentManager` in platform/security | Owner-local create/revoke, absolute expiry + monotonic deadline, principal/node binding, runtime-restart fail closed |
| `UltimateActionPolicy` in platform/security | Typed operation category, workspace/path/profile limit, explicit deny and validation for each action; no blanket shell bypass |
| Control Center permission page | Owner-local activation (30m, 1h, 2h, 4h), exact scope preview, countdown, revoke, unsafe permanent-full-access warning |
| `ProjectHandoffCoordinator` | Controller-driven durable workflow steps and Work Session attribution; no node-to-node remote command control |
| `TransferManifestValidator` | Source/build manifest schema, filename/path/size/hash validation, artifact compatibility and destination conflict handling |
| Existing `MultiNodeAuthorization` | Keep as sole bilateral directional grant and principal-scope authority |
| Existing data plane / relay adapters | Reuse direct offers, per-chunk/final checksums, content-addressed staging, bounded atomic acceptance |
| Existing audit and session systems | Correlated task/transfer events without credential leakage |

Avoid multiplying public MCP tools. Prefer current typed `engineering_workflow_plan/run` envelope (platform workflow IDs) and existing `platform.transfer_*`/`platform.relay_*`. Expose required workflows through a reviewed capability surface only after scope classification; do not bundle dangerous tool families into an automatic "all tools" switch.

## 4. Ultimate session contract

### Activation
- Available only in owner-local loopback Control Center with authenticated local owner session, origin/CSRF checks, and explicit human click.
- Cannot be created, widened, or renewed through MCP, chat prompt, API key, Work Session, incoming transfer, or another workstation.
- Each node has its own independent session and local grant policy; one node cannot activate another.
- One activation duration selected by owner: 30/60/120/240 minutes; server rejects values outside [10 minutes, 4 hours]. Absolute expiry is set once; no automatic renewal, extending, sliding TTL, or client-driven refresh.
- Session bound to exact node identity, tunnel principal, selected authorized workspaces, specific named task profiles and transfer grant IDs/directions, start/expires timestamp. No secret shown in MCP status.
- In-memory authorization is preferred for fail-closed restart: runtime crash/restart cancels outstanding Ultimate consent. Persist bounded non-secret audit history only. Use monotonic deadline for in-process enforcement in addition to UTC expiration; clock rollback cannot extend permission.
- At expiry/revoke, reject all new automatic operations and transfer acceptance; interrupt/cancel operations when safely possible; incomplete bytes stay in temporary staging and are garbage-collected, never accepted as success. Existing runtime process supervision remains authoritative for managed children.
- Status is read-only and reports ACTIVE/EXPIRED/REVOKED/INACTIVE, `expiresAt`, remaining duration, selected operation categories, and the number of approved nodes/grants. No bearer token.

### Allowed by default during active session
- Read-only discovery, Git status, project inspection.
- Typed in-workspace file copy/add and versioned handoff staging with fail-if-exists; no arbitrary overwrite/delete.
- Named deterministic build/test workflows, restricted to approved workspace/project/toolchain/target profiles, output size/runtime/resource limits.
- Independently granted transfer of regular-file source archives, manifests and firmware build artifacts between exact node IDs, workspace relative prefixes and destination bases.
- Read-only log/status/artifact verification and failure recovery that does not mutate production hardware.

### Requires a separate approval or explicit scoped workflow outside default Ultimate consent
- `sudo`, Administrator/UAC, installation/elevation, permanent policy/scope change, tunnel/credential changes, SSH cross-node command control.
- General-purpose raw shell, arbitrary executable/script supplied by an AI prompt, unknown repo build hooks or untrusted instructions without a reviewed build profile/sandbox.
- Delete/format/repartition, force-push/rewrite history, destructive overwrite, updates/restarts of critical production services.
- Firmware flashing/erasing, robot motion/actuation, live power/device mutation; these need named hardware-target validation, interlocks and an independently authorized operation.
- Publishing, outbound messaging, spending money, or sharing secrets.

### Critical interaction with existing permanent Full Access
Inspected machines currently report `configuredMode=full_control`. Ending Ultimate consent does **not** erase this owner's separately configured permanent permission. The UI must state clearly "Ultimate automation expired; your previous Full Access mode remains configured" when applicable, never claim the whole workstation is restricted after 4 hours. For a true four-hour ceiling on full-control authority, propose a separate owner-approved migration to `workspace` base policy plus legacy time-limited full-control leases; do not silently migrate machines during this feature rollout.

## 5. Bilateral Multi-Node Transfer design

**Control**: ChatGPT or another authenticated AI client addresses each Direct Node separately. **Data**: either a bounded direct private/Tailscale transfer or the existing authenticated relay; no permanent hub, public inbound listener, shared private key, or peer command execution.

Each direction is a distinct logical grant, installed by the local owner on **both** participating endpoints:
- `ssd-source-to-windows-build`: source SSD node / `projects`; destination Windows / `stm32`; path prefixes restricted to project handoff exports; destination base `incoming/ssd-build`.
- `windows-build-to-ssd-artifacts`: source Windows / `stm32`; destination SSD / `projects`; prefixes restricted to verified build exports; destination base `incoming/windows-builds`.

The illustrative relative directories must be resolved and approved against real workspace paths before enabling them; no wildcard or root-level grant. Each grant specifies permitted extensions (e.g. `.tar`, `.zip`, `.json`, `.hex`, `.bin`, `.elf`, `.map`, `.log`), max bytes and allowed `direct`/`relay` transport. The dedicated `workstation.cross_node_transfer` scope must be added by the local owner to the expected tunnel principal on each node; `full_control` does not imply this scope.

### File safety / handoff package
- The existing data plane accepts a single regular file. Directory handoff uses a deterministic single package plus manifest, produced with a bounded typed packager in a staging path; this is not an unrestricted arbitrary archive extractor.
- Manifest schema v1: transfer/job ID, source/destination device IDs, workspace/project ID, source revision/dirtiness marker, relative file list with SHA-256 and size, toolchain profile/target, origin timestamp, artifact role, expected output hashes and transfer grant.
- Exclude secrets, credentials, temporary build caches and known generated directories by default. Clean tracked-source snapshot is the preferred path; dirty sources require an explicitly described snapshot with hash evidence, never silently omit uncommitted changes.
- Reject path traversal, absolute archive members, symlinks/hardlinks, unexpected extensions, decompression bombs, collisions, duplicate conflicting content, and destination escape through symlink/reparse points.
- At receiver, verify grant, principal scope, size/hash and package manifest before atomic import. Existing different destination content fails closed; never overwrite a live project or load/execute transferred files automatically.
- Revoke grant before or during transfer must cause denial at the next enforcement point and before final acceptance; clean up partially received staging.
- Direct transfer <=512 MiB only if peer private route exists. No peer route => authenticated relay <=32 MiB; larger payloads fail with an actionable route/size message. Do not funnel large source trees through model chat or base64 narrative.

## 6. Example: Ubuntu SSD -> Windows build -> Ubuntu SSD

1. Controller verifies both node identities, scopes, Ultimate status and two bilateral grants. If any missing, show a precise blocker.
2. SSD builds an approved source package/manifest from authorized project workspace, hashes it; no firmware flash at this step.
3. Controller invokes `platform.transfer_prepare`, `platform.transfer_receive_offer` and `platform.transfer_push` for reachable private routes, or existing `platform.relay_*` resumable fallback for <=32 MiB. Both nodes reauthorize.
4. Windows receives package in an isolated Work Session staging/project directory, verifies hashes, then runs an exact owner-approved STM32 build profile in installed Keil/STM32CubeIDE/CMake; runtime/CPU/memory limits and process cleanup apply.
5. Build acceptance records exit code, target, toolchain/version, warnings/errors, source digest and `.hex/.bin/.elf/.map` hashes; no "success" with missing output.
6. Windows packages the verified artifacts and manifest, sends back through the reverse direction grant; SSD verifies before acceptance to `incoming/windows-builds`.
7. Flashing on SSD remains a separate named hardware operation requiring probe/board/port validation and the corresponding explicit owner/device approval.

A transfer receipt does not imply peer execution authority. Work Session handoff remains source-identity-bound, logged and immutable for that job.

## 7. UI/UX

Control Center new owner-local card:
- Mode selector remains Read only / Workspace / Full access.
- Separate Ultimate Control card showing maximum 4h, operation-category summary, node identity, enabled workspace/profile IDs, activation and immediate revoke buttons.
- Warnings: permanent Full Access state; missing cross-node scope/grant; unavailable nodes; relay 32 MiB; mismatched versions; no reachable direct route.
- Multi-Node page directional grant wizard (sender, receiver, path prefix, destination base, max size, extension list, transports) plus read-only reconciliation report across nodes if each is independently queried by authorized controller.
- One job timeline: PRECHECK -> PACKAGE -> TRANSFER -> BUILD -> VERIFY -> RETURN -> READY_FOR_FLASH; show exact failure and retry/resume scope without duplicating a conflicting artifact.
- Explicit "ChatGPT app approval is managed separately" note, with link to OpenAI permissions settings guidance. No claim that a local RWMCP toggle suppresses ChatGPT confirmation.

## 8. Design risk and mitigations

| Risk | Mitigation |
|---|---|
| Four-hour auto-approve becomes permanent or outlives restart | Non-renewable max-TTL, monotonic deadline, reject on restart and expiry, auditable revocation |
| Persistent Full Access misrepresented as expired | Distinguish base policy from Ultimate consent; warn, offer owner-approved Workspace migration separately |
| Node A compromise controls node B | No horizontal command trust; two local grants, exact principal scope, binding to device/workspaces/path/size/transport |
| Archive/script injects into Windows build | Sanitized package, trusted project/profile, isolated worktree, executable allowlist and OS/VM isolation for untrusted code |
| Partial/corrupt or malicious transfer | Existing chunk/full SHA-256, manifest verification, size caps, no overwrite, atomic promotion |
| Remote connectivity absent | Relay fallback <=32 MiB, else explicit error / optional owner-approved private network route |
| Ubuntu release incompatibility | Capability negotiation and read-only validation before enabling grants; no unapproved Ubuntu update |
| GitHub v0.71.0/main drift | Reconcile commit graph, use v0.71 as protection baseline, PR review with Windows-only tests before merge |
| Platform asks Allow anyway | Truthful separation between local consent and ChatGPT per-app permissions; no attempt to bypass mandatory host prompts |

## 9. Acceptance criteria / tests

**Unit and negative**
1. Every TTL 30/60/120/240 minutes succeeds; TTL >4h, invalid clocks, sliding renewal rejected.
2. Wrong principal, node, workspace, profile or grant rejects, including replayed session ID.
3. Expired/revoked/restarted session refuses new writes or final transfer acceptance; partial temp data cleaned.
4. Ultimate never calls or implies admin/root, arbitrary shell or hardware mutation.
5. Local `configuredMode=full_control` remains accurately visible after Ultimate expires, with a clear warning.
6. No cross-node scope, disabled grant on either end, direction reversal, extension/path/size mismatch, expired transfer ticket all deny.
7. Path traversal/symlink/reparse, archive bombs, digest mismatch and conflicting destination deny.
8. Mid-transfer grant revoke and timeout deny; successful identical retry idempotent.
9. Offline node or no peer route routes only to eligible relay <=32 MiB; over-limit fails clearly.
10. Fresh Client/ChatGPT tool exposure does not accidentally register a broad privileged tool bundle.

**Integration / acceptance**
11. Windows CI: TypeScript, boundaries, security checks, tests, build, plugin validation and control-center permission UI.
12. Local Windows disposable workspace: timed consent, build, revoke, restart and audit.
13. Opt-in pair: Windows laptop + SSD Ubuntu using existing compatible v0.67.2 interfaces, source package to Windows, deterministic STM32 build, artifact return and SHA-256 equality. Never flash real hardware in acceptance.
14. Existing Ubuntu Vision services and legacy packages untouched. No Windows production upgrade before review/CI.
15. Measure precheck/transfer/build/return latency and max RSS; report rather than invent performance numbers.

## 10. Delivery order and rollout

- Phase 0 — Version/feature reconciliation: compare v0.71.0 release with main, inspect installed Windows capabilities, inventory existing Linux workflow versions read-only.
- Phase 1 — Ultimate Consent domain model + owner-local UI + policy/audit tests, feature flag default OFF.
- Phase 2 — Multi-node owner grant UX, scoped tunnel privilege reconciliation, read-only readiness/direction tests.
- Phase 3 — Generic project handoff manifest/package validators and deterministic workflow orchestration on top of existing transfer and Work Session systems.
- Phase 4 — Windows CI/test acceptance + two-node dry run using disposable paths; no real flash.
- Phase 5 — Review PR, owner acceptance, then staged Windows deployment with rollback. Ubuntu frozen releases remain pinned; any Linux update requires a separate explicit decision.

**Release/rollback**: no auto-deployment; version slots and owner config separated, feature defaults OFF, preserve existing runtime as rollback candidate. Revert new UI/consent behavior without deleting project files/grants; any cleanup of a disposable acceptance directory is explicit, scoped, and recoverable when possible.

## 11. Non-goals

No unrestricted autonomous root/Administrator mode; no automatic Windows UAC bypass; no bypass of ChatGPT approvals; no credential pooling among nodes; no all-to-all transfer permission; no generic peer shell over SSH; no automatic Ubuntu release or Vision/SSD service modification; no automatic firmware flashing; no changing PCB production artifacts as part of this acceptance.

## 12. Approval request

Owner should approve or correct this design before writing implementation code. On approval, create an execution plan with file-by-file tasks and tests, then implement/review in a development branch without merging/deploying until acceptance.
