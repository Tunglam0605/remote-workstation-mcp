# Windows v0.71.1 Candidate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task; track RED→GREEN when changing production behavior.

**Goal:** Prepare a source-preserving Windows v0.71.1 candidate suitable for explicit owner release approval.

**Architecture:** Isolated release worktree based on `9b8ba7fd6dff0a0ca042cf1d82437bf97f763803`; no stable runtime, original PCB or Ubuntu mutations. Patch version-bearing metadata and acceptance docs only; verify the exact candidate via Windows native tests, package smoke, CI and controlled installer/rollback rehearsal.

**Tech Stack:** TypeScript 6, Node 22/24, npm, GitHub Actions Windows, KiCad 10.0.6, PowerShell.

**Spec:** `docs/superpowers/specs/2026-10-25-windows-v0711-release-design.md`

## Global Constraints

- Windows-only publication target; Ubuntu distributions remain frozen.
- No new MCP tools, schema 74 unchanged and engineering API 5 unchanged.
- Do not overwrite installed `v0.71.0` or production tunnel/configuration.
- Original V185 SHA: `6da153750d08a3a5e71557c5136a08c829f400a8c4d4b87addd0782408842c3e`; zero original file writes.
- Do not publish tag, GitHub Release or install to production before explicit owner acceptance.
- Do not merge into `main` until divergence is reconciled and reviewed.

## Review Focus

1. Inconsistent version fields in package, lockfile, plugin manifests and `SERVER_VERSION` → must fail validation.
2. Windows npm permission bypass (`cmd.exe`, arbitrary .cmd, pre-policy resolver) → no new authority.
3. Named KiCad net aliases causing 0 routes/zones → expected 81 nets and 234 copper zones on read-only V185.
4. Branched/via-bearing power nets mistakenly emitting voltage drop → eligible=false, no numeric drop.
5. Installer/update/rollback affecting active user slot or tunnel during rehearsal → use isolated profile and abort.

---

### Task 1 — Candidate version metadata and release notes

**Files:**
- Modify: `package.json`, `package-lock.json`, `plugins/remote-workstation/plugin.json`, `plugins/remote-workstation/.codex-plugin/plugin.json`, `src/capabilities.ts`, `CHANGELOG.md`.
- Test: existing `npm run plugin:validate`, `npm run typecheck`, project version checks, `node dist/cli.js --version`.

**Interfaces:** Consumes combined tested code `9b8ba7f`; produces version-consistent `0.71.1` distribution metadata.

- [ ] Verify clean native worktree and baseline `HEAD`; verify current `0.71.0` fields.
- [ ] Make minimal metadata-only bump to `0.71.1`; do not alter schema/API constants.
- [ ] Add accurate Windows-only changelog entry and explicit no-fabrication/no-autonomous-deploy hold.
- [ ] Run version-consistency assertions, typecheck, plugin validation; commit only version metadata and notes.

### Task 2 — Native Windows engineering and security acceptance

**Files:** Report only at `docs/WINDOWS_V0711_RELEASE_ACCEPTANCE_20261025.md`.

**Interfaces:** Consumes candidate SHA; produces documented checks and immutable source hash.

- [ ] `npm ci` in isolated candidate only.
- [ ] `npm audit --omit=dev --audit-level=high` must exit 0.
- [ ] `npm run verify` (all mandatory scripts) must exit 0.
- [ ] Native read-only KiCad CLI ERC/DRC: zero active violations/unconnected/parity; report ignored count explicitly.
- [ ] Using candidate analyzers on V185, assert source SHA and 81/971/130/234, 17/3 review geometry, and fail-closed DC limits.
- [ ] Build `npm pack` into isolated candidate output and run `scripts/smoke-package-windows.ps1`; never target owner-installed slot.
- [ ] Record exact outputs, logs, SHAs and blockers in acceptance report.

### Task 3 — GitHub reviewable candidate

**Files:** No production changes beyond Task 1/2.

**Interfaces:** Produces draft candidate PR based on published `v0.71.0` lineage; preserves stacked PR trace.

- [ ] Push branch `release/windows-v0.71.1-candidate-20261025` only after local gates pass.
- [ ] Create draft PR targeting `release/windows-v0.71.0-candidate-20261014`; show seven inherited commits plus metadata/report.
- [ ] Verify Windows CI success on exact PR SHA and run independent code review.
- [ ] Record `main` merge-only divergence (commit `2a07b91`, empty tree delta versus merge base); prepare separate non-force reconciliation route.

### Task 4 — Owner release decision (explicit hold)

**Files:** Only approved release metadata/workflow, after new authorization.

- [ ] Rehearse version-pinned installer and guarded rollback on disposable runtime/profile; do not affect live tunnel.
- [ ] Verify published `v0.71.0` remains healthy and owner original PCB still has same hash.
- [ ] Present artifact hashes, CI result, package smoke, release changes and rollback command to owner.
- [ ] Ask owner to authorize tag/publish and production upgrade. **Do not run tag/release/update without authorization.**
