# Windows npm launcher fix — implementation plan

**Spec:** docs/superpowers/specs/2026-10-25-windows-npm-launch-design.md

**Goal:** Correct `spawn npm ENOENT` on Windows after explicit owner approval, without shell or policy bypass.

**Worktree:** `remote-workstation-mcp.windows-npm-shim-20261025`, branch `fix/windows-npm-shim-launch-20261025`, from PR #272 integration HEAD.

**Task 1 — Launch contract and tests**
Files: `tests/windows-npm-launch.test.ts` (new), `src/adapters/windows-npm-launch.ts` (new).
1. RED: add focused tests using real isolated temporary npm.cmd/npm-cli.js fixture, for explicit Windows program, positional/escaped args, missing scripts, non-Windows fallback, unrelated .cmd fallback.
2. Run `node --experimental-strip-types --test tests/windows-npm-launch.test.ts` on Windows Node 24. Expected: module missing/contract failure before production module.
3. GREEN: implement minimal npm launch resolver returning executable + argument array only; no generic shell.
4. Rerun focused test. Expected: all green.

**Task 2 — Integrate with ProcessManager**
File: `src/adapters/process-manager.ts`.
1. Before modification, add a targeted ProcessManager regression test if dependencies are installed; otherwise document dependency blocker and use CI as integration gate.
2. Keep `PolicyEngine.assertExecute(program)` BEFORE transformation; compute safe env once; resolve authorized npm and spawn with `shell:false`.
3. Verify failing case, then relevant process tests and typecheck. Expected: no new failures.

**Task 3 — Security + CI + KiCad acceptance**
1. Run isolated `npm ci` and `npm run verify` once a legitimate owner-managed task/installer route works; do not bypass denied executables.
2. Resolve dependency audit advisories by tested lockfile update, without disabling audit.
3. Confirm all Windows CI, process-tree and KiCad analysis checks.
4. Keep both PRs draft until exact-commit acceptance is satisfied; never update stable runtime or original PCB as part of this plan.

**Review focus:** Path search bounds; no `cmd.exe`; shell-metacharacter arguments intact; policy checked before launcher; no unbounded subprocess; no misleading release-status claims.
