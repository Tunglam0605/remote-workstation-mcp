# Multi-Node Project Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reuse the existing secure RWMCP data plane to transfer verified project sources and build artifacts between an Ubuntu SSD node and a Windows builder through consent-gated, typed workflows.

**Architecture:** Generic project packaging/acceptance runs locally on each Direct Node. An authenticated controller coordinates both independent nodes using existing bilateral `MultiNodeAuthorization` and `platform.transfer_*` / `platform.relay_*` envelopes. A Work Session records job progress; a node never executes commands on a peer. Windows build stays an existing trusted typed toolchain workflow.

**Tech Stack:** TypeScript/Node >=22, `fflate`, existing RWMCP workflow engine, `MultiNodeAuthorization`, Work Sessions.

**Spec:** `docs/superpowers/specs/2026-10-24-ultimate-control-4h-multinode-design.md`

## Global Constraints

- Complete `2026-10-24-ultimate-control-4h.md` and reuse its `UltimateActionPolicy` for newly implemented auto handoff workflow transitions.
- Build on v0.71.0 source baseline, Windows-only development. Ubuntu frozen binary must not be overwritten or upgraded by this plan.
- No peer command execution, arbitrary source-root transfer, wildcard grants, or owner-policy mutations via MCP.
- Existing transfer limits: direct <=512 MiB if private route exists; relay <=32 MiB, chunks <=64 KiB; grant scope and authorization on both nodes.
- Each transfer operates on one regular workspace file. Directory handoff uses deterministic archive and strict manifest; destination is fail-if-exists and atomic.
- No credentials/.env/Git private material in packages. No auto firmware flash, erase or production service restarts.
- ChatGPT disconnection never starts new phases autonomously; exact failed/incomplete status supports controller-driven retry.

## Review Focus

1. Symlinks, Windows reparse points, absolute/archive traversal and source path collisions must deny — Task 1/2.
2. Zip bomb, duplicate archive entry, SHA mismatch, missing expected file and changing source during pack must deny — Task 1/2.
3. Either node's grant revoked or scope missing must deny before final artifact acceptance — Task 3.
4. A missing peer route and >32 MiB relay request must fail with exact remedy — Task 4.
5. Untrusted project build hooks, dirty Git worktree or unexpected toolchain target must not be executed automatically — Task 5.

---

### Task 1: Versioned Manifest Contract

**Files:**
- Create: `src/adapters/engineering/handoff-manifest.ts`
- Test: `tests/handoff-manifest.test.ts`

**Interfaces:**
- `type HandoffRole = 'source' | 'build_artifacts'`
- `interface HandoffFile { relativePath: string; bytes: number; sha256: string }`
- `interface HandoffManifestV1 { schemaVersion: 1; jobId: string; sourceNodeId: string; destinationNodeId: string; sourceWorkspace: string; destinationWorkspace: string; projectId: string; sourceRevision: string; role: HandoffRole; toolchainProfileId?: string; createdAt: string; files: HandoffFile[] }`
- `validateHandoffManifest(value: unknown): HandoffManifestV1` validates bounds, normalized paths, duplicate filenames, SHA-256, size and identities using Zod.

- [ ] **1.1 RED:** Valid manifest and invalid version, absolute/traversal/symlink-shaped paths, duplicate paths, malformed digest, missing fields and excessive file count/size.
- [ ] **1.2 Verify RED:** `node --import tsx --test tests/handoff-manifest.test.ts`.
- [ ] **1.3 GREEN:** Minimal validator and immutable normalized result, no filesystem mutation.
- [ ] **1.4 Verify GREEN:** Focused test, typecheck and full suite; commit `feat(handoff): validate versioned project manifests`.

### Task 2: Deterministic Package and Atomic Acceptance

**Files:**
- Create: `src/adapters/engineering/handoff-package.ts`
- Test: `tests/handoff-package.test.ts`

**Interfaces:**
- `packageHandoff({workspaceRoot, projectRelativePath, manifestDraft, outputRelativePath, includedFiles}): Promise<{relativePath,sha256,bytes,manifest}>`.
- `acceptHandoff({workspaceRoot, archiveRelativePath, expectedSha256, destinationRelativeBase, expectedRole}): Promise<{acceptedPath,manifest,sha256}>`.
- All path resolution goes through existing workspace path guard. Named source files must be regular files and disallow secret/default excluded prefixes. Extraction is bounded by manifest sizes and total limits.

- [ ] **2.1 RED:** Stable deterministic archive hashes, dirty/untracked-source explicit snapshot handling, symlink/escape and secret excludes; reject forged entries, checksum mismatches, zip bomb and destination existing conflict.
- [ ] **2.2 Verify RED:** Focused suite fails on missing packager.
- [ ] **2.3 GREEN:** Use bundled `fflate` archive primitives and existing filesystem guards; temporary staging plus atomic verified import, no blind overwrite.
- [ ] **2.4 Verify GREEN:** Focused tests, typecheck and full suite; commit `feat(handoff): package and accept verified workspace artifacts`.

### Task 3: Typed Workflow Contract and Consent Gate

**Files:**
- Modify: `src/adapters/engineering/workflow-contract.ts`, `src/adapters/engineering/workflow-engine.ts`, related dependency injection in `src/bootstrap/engineering-services.ts`.
- Test: `tests/handoff-workflow.test.ts`, `tests/engineering-workflow.test.ts`.

**Interfaces:**
- `platform.handoff_package` accepts one authorized workspace, project path, exact non-secret file list and export path; invokes Ultimate `workspace_add`.
- `platform.handoff_accept` accepts verified archive path, destination base, role and expected hash; invokes Ultimate `artifact_verify`.
- Existing `platform.transfer_*`/`platform.relay_*` continue to enforce bilateral owner grants independently; new handoff does not bypass or silently create these grants.

- [ ] **3.1 RED:** Action appears in planning/listing; deny inactive consent, denied profile/grant, wrong Work Session and invalid digest.
- [ ] **3.2 Verify RED:** Focused suite fails for missing action.
- [ ] **3.3 GREEN:** Add the two typed workflow IDs and bounded input contracts; reuse current workflow-run audit.
- [ ] **3.4 Verify GREEN:** Focused/full tests and architecture boundaries; commit `feat(handoff): expose consent-gated project transfer workflows`.

### Task 4: Readiness, Direct/Relay Transfer Plan and Failure Modes

**Files:**
- Create: `src/adapters/engineering/handoff-readiness.ts`
- Test: `tests/handoff-readiness.test.ts`
- Modify: `docs/DATA_PLANE.md` only if contract changed.

**Interfaces:**
- `planHandoffTransport({sourceHealth,destinationHealth,bytes,grant,scope}): {eligible: boolean; transport?: 'direct'|'relay'; reasons: string[]}`; explicit conservative route availability, not assumption from independent tunnel online.
- Existing low-level transfer tools perform actual independently authorized sends/receives. No automatic new public listener.

- [ ] **4.1 RED:** Both scopes/grants, missing receiver, no direct peer route, <=32 MiB relay fallback, >32 MiB failure and expired consent.
- [ ] **4.2 Verify RED:** Missing planner failure.
- [ ] **4.3 GREEN:** Deterministic readiness checker from inspected statuses; do not open sockets on plan.
- [ ] **4.4 Verify GREEN:** Focused/full tests; commit `feat(handoff): report cross-node transfer readiness`.

### Task 5: Trusted Build / End-to-End Dry Run

**Files:**
- Create: `tests/handoff-build-fixture.test.ts`
- Update: `docs/OPERATIONS.md`, `docs/MULTI_DEVICE.md`, acceptance checklist.

**Interfaces:** No generic executable-from-manifest. The receiver chooses a pre-existing owner-approved Keil/CMake project profile and checks source revision/profile ID against its allowlist before invoking existing typed build workflow.

- [ ] **5.1 RED:** Unknown project, dirty/changed source without manifest, unexpected target and unapproved pre/post hook are blocked before building.
- [ ] **5.2 GREEN:** Minimal preflight tied to current owner project profile and exact source digest.
- [ ] **5.3 End-to-end fixture:** disposable source package -> simulated two-node transfer receipt -> Windows-build profile preflight -> deterministic artifact manifest -> reverse receipt; assert round-trip hash equality. Never flash board.
- [ ] **5.4 Verify:** `npm run verify` on Windows CI; if Linux legacy contracts cannot accept grants, report blocked and request new authority, no Linux rollout.
- [ ] **5.5 Commit:** `test(handoff): accept verified two-node project round trip`.

**Exit gate:** PR review of source and Windows CI, separate owner approval for enabling exact bilateral grants and choosing a real first project. Do not deploy to Windows/Ubuntu as part of implementation work.
