# Windows v0.71.0 KiCad integration and acceptance — implementation plan

> For agentic workers: implement task-by-task with test-first changes; do not merge, tag, deploy or update any workstation until the acceptance gates below are satisfied.

**Goal:** Qualify PR #269, #270 and #271 as one reviewable, source-preserving KiCad analysis increment over the published Windows v0.71.0 code line.

**Architecture:** Preserve the published tag `v0.71.0` (commit `921f6afa7cea49a5aa5dc0c34cc14d4e3dfa0421`) as the acceptance baseline. The head of PR #271 (`b2a981468b5508e36a78e9b0de29baa57d99d654`) is exactly three commits ahead and contains all three stacked PR changes. Review and validate in a separate integration branch; do not merge into `main` while its history diverges from the stable release line.

**Tech Stack:** TypeScript, Node.js, MCP, GitHub Actions CI, Windows 11, KiCad 10.0.6.

**Spec:** `docs/PROJECT_CHARTER.md`, `docs/ARCHITECTURE_MAP.md`, `docs/WINDOWS_ENGINEERING_WORKFLOW_ACCEPTANCE.md`, PR #269–271.

## Global Constraints

- Windows is the sole active feature-development target; Ubuntu SSD/Vision/Personal distributions remain frozen.
- Never write to the original Mega2560 V185 PCB, Gerber or BOM as part of this integration.
- Source PCB reference SHA-256: `6da153750d08a3a5e71557c5136a08c829f400a8c4d4b87addd0782408842c3e`.
- This increment is read-only analysis plus preview-only 45-degree geometry; no new auto-route or manufacturing permission is implied.
- Preserve exact net attribution for numeric, named-only and mixed KiCad 10 tokens; do not synthesize unsupported DC voltage-drop estimates through branches, loops, vias or zones.
- No release, production installer, remote runtime update, hardware flash or autonomous approval in this plan.
- PRs #269–271 remain independently traceable. Avoid force-push or history rewrite.
- `main` versus `v0.71.0` has a divergent history (observed: stable ahead 20, behind 1); resolve this separately after acceptance.

## Review Focus

1. Named-only net tokens: review must report the same physical nets across design, electrical and constraints analyses.
2. Mixed numeric/named tokens: deterministic mapping must avoid accidental collisions and missing copper.
3. DC power nets with branches/vias/zones: report unsupported calculation, not a fabricated scalar voltage drop.
4. 90-degree and reversal previews: coordinates, widths, layers and source segment indices must be bounded and reproducible; no PCB mutations.
5. Missing native KiCad or stale PCB digest: acceptance must block, never claim zero warnings or manufacturing readiness.

---

### Task 1 — Consolidated staging PR

**Files:** Existing code from `src/adapters/engineering/kicad-board-net-resolver.ts`, `kicad-constraints-review.ts`, `kicad-electrical-review.ts`, `kicad-dc-path-safety.ts`, `kicad-route-quality.ts` and corresponding tests. This plan is additive documentation only.

**Interfaces:**
- Consumes: published v0.71.0 tag and stacked PR #269–271.
- Produces: one draft integration PR targeting `release/windows-v0.71.0-candidate-20261014`.

- [x] Compare `v0.71.0...feat/windows-kicad-junction-evidence-20261018`; observed exact three-commit fast-forward lineage, 14 changed files.
- [x] Create isolated integration branch `integration/windows-v0710-kicad-acceptance-20261025` at commit `b2a981468b5508e36a78e9b0de29baa57d99d654`.
- [ ] Open a single draft PR with an explicit no-deployment hold and inherited PR #269–271 references.
- [ ] Confirm the PR diff contains only the expected KiCad analysis/test/docs increment and run new CI on the integration PR.
- [ ] Verify GitHub Actions conclusion is `success` at the exact integration HEAD.

### Task 2 — TypeScript and unit regression gate

**Files:** Do not change production files unless a regression is demonstrated by a failing test. Relevant tests:
- `tests/kicad-constraints-review.test.ts`
- `tests/kicad-electrical-review.test.ts`
- `tests/kicad-design-review.test.ts`
- `tests/kicad-dc-path-safety.test.ts`
- `tests/kicad-route-quality.test.ts`

**Interfaces:** Consumes the code line qualified by Task 1. Produces reproducible failure/pass evidence and immutable commit SHA.

- [ ] On a clean Windows worktree, record Node.js/npm versions, `git status --short`, `git rev-parse HEAD`.
- [ ] Run `npm ci`; require zero install errors.
- [ ] Run `node --import tsx --test tests/kicad-constraints-review.test.ts tests/kicad-electrical-review.test.ts tests/kicad-design-review.test.ts tests/kicad-dc-path-safety.test.ts tests/kicad-route-quality.test.ts`; require zero failures.
- [ ] Run `npm run verify` (security, supply-chain, TypeScript, architecture, growth, all tests, build, plugin); require exit 0.
- [ ] For any defect, add a reproducing test, observe RED, make minimal change and observe GREEN before repeating all gates.

### Task 3 — Native Windows KiCad 10.0.6 acceptance

**Files:** No original project mutation. Record review results in a new dated document under `docs/` only after executing the tests.

**Interfaces:** Consumes exact v0.71.0 integration commit and V185 board SHA. Produces local native KiCad/board-evidence report.

- [ ] Verify Windows RWMCP tunnel identity/version and that the installed KiCad executable is exactly version 10.0.6; distinguish installed program, IPC readiness and official CLI availability.
- [ ] Open owner-authorized V185 project read-only; verify SHA `6da153750d08a3a5e71557c5136a08c829f400a8c4d4b87addd0782408842c3e` before and after.
- [ ] Reproduce named-net counts on unchanged V185: 81 routed nets, 971 segments, 130 vias, and 234 named copper zones (based on prior PR evidence; new observation must be recorded independently).
- [ ] Verify 17 near-right-angle / 3 reversing candidates are advisory, not DRC violations or automatic rewrites; verify coordinate and width evidence.
- [ ] Inspect power-net limitations and verify no unsupported DC series-path number is presented.
- [ ] Execute official KiCad ERC/DRC on an isolated copy where appropriate; classify all warnings, violations, unconnected and parity issues separately.
- [ ] Compare source digest, generated outputs and acceptance report; report any deviation as blocked.

### Task 4 — Integration and release decision gate

**Files:** Update dated acceptance report/PR review only; release sources/installer remain untouched.

**Interfaces:** Consumes all Task 1–3 evidence. Produces a clearly documented accept/reject recommendation, not a deployment.

- [ ] Review GitHub PR #269–271 code and dependencies, plus the combined staging diff.
- [ ] Confirm Windows CI, native KiCad results, owner review and exact SHAs.
- [ ] Establish a separate reconciliation PR from the accepted stable release lineage to `main`; do not force-push or silently drop main-only work.
- [ ] Keep the integration PR draft if any native, DRC, electrical, security or release gate is incomplete.
- [ ] Request explicit owner release/deployment decision only after acceptance and a tested rollback path.

## Deferred, separately scoped work

- SSD ↔ Windows Multi-node cross-transfer requires reachable Windows tunnel, bilateral grants, and an approved local file/build test. Ubuntu changes are out of scope.
- Ultimate Control 4H remains a design branch; do not reinterpret it as authorization to elevate privileges or auto-merge.
- Copy-only DRC-gated 45-degree repair is future implementation; this PR only previews review geometry.
