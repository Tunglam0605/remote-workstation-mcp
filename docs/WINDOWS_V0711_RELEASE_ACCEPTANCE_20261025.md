# RWMCP Windows v0.71.1 — Release Candidate Acceptance Evidence

Date: 2026-10-25. Candidate worktree: `release/windows-v0.71.1-candidate-20261025`. Stable installed runtime remains `v0.71.0` on node `TungLamAutomation`.

## Immutable source and scope
- Candidate fork: `9b8ba7fd6dff0a0ca042cf1d82437bf97f763803`, seven fast-forward commits beyond published `v0.71.0` (`921f6afa7cea49a5aa5dc0c34cc14d4e3dfa0421`), combining PR #269–273.
- Version fields: `package.json`, `package-lock.json` root and root package, both plugin manifests, `src/capabilities.ts` all `0.71.1`. `BUILD_CHANNEL=stable`, `ACTION_SCHEMA_VERSION=74`, `ENGINEERING_API_VERSION=5` unchanged.
- Windows only; no Ubuntu, owner PCB, Gerber, BOM, controller firmware or running runtime mutations.
- This is a release candidate, **not** a release or manufacturing signoff.

## Native Windows acceptance observed
| Gate | Result | Evidence |
| --- | --- | --- |
| Isolated `npm ci` | PASS | 241 packages, exit 0 |
| Production dependency audit | PASS | `npm audit --omit=dev --audit-level=high`: found 0 vulnerabilities |
| Version invariants | PASS | Six version values = 0.71.1; schema 74, engineering API 5, stable channel |
| `npm run verify` | PASS | 1144 tests: 1142 pass, 0 fail, 2 skip, exit 0; typecheck, security, architecture, build, plugin validate (after reviewer findings) |
| Growth budget | REVIEW-REQUEST | Published v0.71.0 tracked 90 docs; six inherited KiCad/npm records plus three release records yield 99. Existing budget 97 → requested 99, bytes unchanged; `architecture:growth` PASS. Review rationale in `docs/PROJECT_GROWTH_POLICY.md`. |
| KiCad CLI | PASS | Official KiCad 10.0.6 available |
| KiCad ERC | PASS | Zero violations / exclusions |
| KiCad DRC | PASS WITH DISCLOSURE | Zero active violations, unconnected, schematic-parity or exclusions; 5 ignored check categories |
| New KiCad analyzer on real V185 | PASS | 81 routed nets, 971 straight segments, 130 vias, 234 named zones, 17 near-right-angle and 3 reversal review candidates |
| Electrical four-net guard | PASS | `/BUCK_5V`, `/VIN_PROTECTED`, `/EFUSE_RTN`, `/5V` routed and all withhold unsupported numeric DC voltage drop (via topology) |
| Reviewer DC ambiguity regression | PASS | Overlapping same-layer copper, midpoint T-junctions and track crossings are denied; electrical path withholds computed resistance/drop. 1,024-track geometry complexity cap fails closed. |
| Owner original V185 SHA | PASS | `6da153750d08a3a5e71557c5136a08c829f400a8c4d4b87addd0782408842c3e` before and after analysis |
| Isolated package pack | PASS | Native `npm pack --pack-destination ...` exit 0; generated `remote-workstation-mcp-0.71.1.tgz` (~27.0 MB) in owner-authorized build-artifact folder. SHA-256 to be attached to PR after final pack. |
| Windows packed runtime smoke | PENDING CI | Local `powershell.exe` is not process-allowlisted; RWMCP `process_start` returned `INVALID_ARGUMENT`. No bypass attempted. Existing Windows CI executes packed smoke in controlled runner. |
| GitHub Windows candidate CI | PENDING | Must be green on exact candidate SHA after commit/push |
| Isolated installer/update/rollback rehearsal | PENDING | Run only on disposable profile/runtime slot, never active Windows owner profile |
| Independent code and release review | IN PROGRESS | Independent review identified a real overlapping-track bug and incorrect docs count; addressed in candidate, final-head re-review required. |
| GitHub Release / tagged publication | HOLD | Tag triggers automatic publication in `release.yml`; explicit owner sign-off required before tag |
| Installed production runtime | PRESERVED | No upgrade, restart or release performed |

### KiCad rule limitations
Ignored checks: `footprint_filters_mismatch`, `footprint_type_mismatch`, `missing_courtyard`, `track_not_centered_on_via`, `tuning_profile_track_geometries`. The first four DC guard examples contain vias; effective current path, copper thickness and zones are not fully modeled. A clean ERC/DRC and geometry counters never certify signal integrity, power delivery, connector fit or manufacturing outputs.

### PCB fabrication package note
The V185 `V185_RELEASE_MANIFEST.json` records a pre-IOREF-alignment board hash. The documented 2026-10-18 current Gerber file is `V185_IOREF_ALIGNED_20261018_PCB_GERBER_DRILL.zip`. Fabrication handoff must reconcile its package manifest and verify zip contents separately. This is **not** an RWMCP executable-release gate and no original PCB or manufacturing artifact was changed here.

### Git branch reconciliation
`main` is 1 commit ahead and 20 behind published `v0.71.0`, with one main-only merge commit `2a07b91d36cc30d90c9961738ca5eeb3308d3c68` and no tree delta versus its merge base. Reconcile histories without force push; do not silently overwrite main.

## Automatic patch-update exposure
The Windows updater defaults to `enabled=true`, `channel=stable`, `automaticPolicy=patch` and a 12-hour check interval (`scripts/update-windows.ps1`). A new `v0.71.1` tag and public GitHub Release can therefore initiate **unattended upgrades on already-configured Windows nodes**, not just create an optional download. Verify the live node's actual update policy, prove staging/rollback and receive owner authorization **before** tagging or publishing.

## Release decision
Candidate packaging, independent review, exact-head Windows CI, isolated rollback proof and owner authorization remain mandatory before publication/deployment. **Status: HOLD.**
