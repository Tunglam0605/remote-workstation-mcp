# Windows RWMCP v0.71.1 candidate — design and release boundaries

Date: 2026-10-25

## Intent
Prepare a traceable Windows-only patch release integrating the existing, already-tested KiCad analysis correction stack (PR #269–272) and the Windows npm shim + dependency security fix (PR #273). Preserve the installed `v0.71.0` runtime until owner acceptance.

## Scope and non-goals
- Source lineage: published `v0.71.0` commit `921f6afa7cea49a5aa5dc0c34cc14d4e3dfa0421` → existing seven-commit integration head `9b8ba7fd6dff0a0ca042cf1d82437bf97f763803` → isolated release metadata commit.
- No new MCP actions or protocol compatibility break; Action Schema stays 74, Engineering API stays 5.
- Windows active target only. Ubuntu Personal, SSD and Vision historical distributions remain unchanged.
- No changes to the user's original Mega2560 V185 KiCad files, Gerber, BOM or hardware.
- Analysis/preview tools do not authorize automatic PCB routing, validated DC drop or manufacturing release.
- No publication tag, GitHub Release, production installer, automatic update or merge to main without a separately recorded owner release decision.

## Options considered
1. **Windows patch v0.71.1 (selected):** minimal metadata bump over audited code; fastest traceable risk reduction, no advertised functionality expansion.
2. Windows minor v0.72.0: implies broader feature delivery and a larger acceptance perimeter, unjustified by this read-only increment.
3. Delay versioning and continue indefinite dev builds: loses a clear release candidate and owner acceptance checkpoint.

## Architecture
Keep `release/windows-v0.71.1-candidate-20261025` in a separate native worktree based on the verified combined feature branch. Change only version-bearing metadata, dated release notes and acceptance evidence, while retaining all source and tests exactly as tested. Create a draft PR against the published v0.71.0 release lineage; run native Windows `npm run verify`, production dependency audit, packed-runtime smoke and GitHub CI on the exact resulting SHA.

## Acceptance evidence
- Windows native `npm run verify` on source head: 1,139 pass, 0 fail, 2 skip (2026-10-25).
- Native Windows KiCad 10.0.6 ERC=0, DRC=0 violations, 0 unconnected, 0 parity, with 5 ignored checks explicitly disclosed.
- V185 original SHA-256 fixed at `6da153750d08a3a5e71557c5136a08c829f400a8c4d4b87addd0782408842c3e` before and after; new code independently produces 81 routed nets, 971 segments, 130 vias, 234 zones and 17/3 geometry advisories.
- Four power nets (/BUCK_5V, /VIN_PROTECTED, /EFUSE_RTN, /5V) must withhold unsupported DC voltage-drop values.
- A clean package build/Windows CI does not establish manufacturing quality or safe production deployment.

## Release gates
1. Package, lockfile, both plugin manifests and `src/capabilities.ts` agree on `0.71.1`; `CHANGELOG.md` explains changes and limitations.
2. Native Windows tests, typecheck, security audit, architecture, build, plugin validate, package smoke and CI are green for the exact candidate.
3. Production upgrade/rollback rehearsal uses a disposable user profile or isolated runtime slot; active owner profile and tunnel remain untouched.
4. Investigate and preserve one main-only merge commit `2a07b91`: GitHub diff to its merge-base is empty; ensure the accepted stable code line is eventually reconciled to `main` without rewriting history.
5. PR review and explicit owner confirmation for actual release/tag/publish/deploy. Current `release.yml` automatically publishes a Release after the tag, so tagging cannot be an implicit acceptance step.


## Owner-approved ephemeral Windows release rehearsal (2026-10-25)

The owner approved expanding candidate acceptance on **GitHub Actions `windows-latest` only**. The installed Windows `v0.71.0` service, its updater policy (`enabled=true`, `channel=stable`, `automaticPolicy=patch`, 12-hour interval), and all Ubuntu nodes must remain untouched.

### Approaches and tradeoffs
1. **Selected:** Stage published, SHA-256-verified `v0.71.0` and a locally packed `v0.71.1` from the exact PR commit under a unique Windows runner temporary profile. Simulate the installer's current/previous runtime-pointer promotion and invoke the **real production `install-windows-release.ps1 -Rollback`** against only that disposable profile. This verifies both packaged runtimes and the real rollback entrypoint without exposing unreleased code to auto-updaters.
2. Publish a temporary `v0.71.1` release to exercise the online installer: rejected because tagging automatically publishes and can trigger unattended owner upgrades.
3. Add a local-unverified-package bypass to the production installer: rejected because it expands a trusted release boundary merely for testing.

### Rehearsal contract
- Use existing `.github/workflows/ci.yml` on the PR's exact SHA, not a shared Windows workstation, and no installed-owner permissions or credentials.
- Download both `remote-workstation-mcp-v0.71.0.tgz` and `SHA256SUMS.txt` from the immutable published v0.71.0 release assets, check version, checksum and package contents before staging. Fail closed on unavailable/mismatched assets; never substitute a synthetic old runtime.
- Create a unique `$env:TEMP` scoped `LOCALAPPDATA`, install production dependencies under two disposable slots, and verify `node dist/cli.js --version` for `0.71.0` and `0.71.1`.
- Establish baseline `current.txt`, simulate only the version-slot pointer promotion (`previous.txt` to v0.71.0, `current.txt` to v0.71.1), invoke the existing installer with `-Rollback` in a child PowerShell whose LOCALAPPDATA points inside that unique temp tree, and assert both pointers reversed, launcher recreated and v0.71.0 still executable. A negative test with a missing previous pointer must fail without changing current.
- Cleanup only the unique disposable tree in a `finally` block. Include the exact-head CI link and observations in PR #274. The real online release-download and owner-machine upgrade remain untested and must not be claimed as tested.
- A **release tag still requires an explicit owner decision** because real owner Windows automatic patch updates are enabled.

## Risk notes
- `npm` resolver must retain policy validation and `shell:false`; generic .cmd execution stays forbidden.
- KiCad has 5 ignored DRC checks, and V185 fabricator ZIP/manifest has a documented IOREF revision split; fabrication requires separate correct-file/hash acceptance.
- Published release assets are immutable; rollback verification precedes machine deployment.
