# RWMCP Windows KiCad — Open-source audit and autonomous PCB experiment milestone
Date: 2026-10-14 | Target: Windows-only RWMCP | KiCad 10.0.6
Repository baseline: PR #259 (fe1c21b). Development: feat/kicad-isolated-autoexperiment-20261014.

## Comparison of upstream projects

| Repository | Verified capabilities | RWMCP gap / adoption choice | Licensing / evidence |
|---|---|---|---|
| [atoplace](https://github.com/glovepost/atoplace) | Three-phase Manhattan legalizer (snap-to-grid, PCA-oriented row alignment, push/shove collision resolution); footprint priorities; star model for high fanout; board visualization | RWMCP already has fixed refs, alignment, keepout/courtyard constraints, but **not** general physics-driven compaction, passive-cluster legalization or safe pin swaps. Develop own deterministic legalizer with genuine board-copy/DRC gates | MIT. Inspected `atoplace/placement/legalizer.py` and README |
| [KiCraft](https://github.com/laforestlabs/KiCraft) | Public README advertises schematic hierarchy, per-functional-block placement config, iterative placement/routing/scoring and experiment snapshots/pinning | Reproduce **copy-only iterations** and evidence-driven best-candidate selection, no dependence on KiCad 9 Python internals. Repo contents not accessible through linked GitHub API at audit time; this row is README evidence only | Public README retrieved. Source inspection incomplete |
| [Freerouting](https://github.com/freerouting/freerouting) | Standalone DSN -> SES advanced iterative routing, CLI `-de`, `-do`, `-mp`, `-mt`; production KiCad connector uses DSN/SES, JSON API experimental | Consider optional **out-of-process** CLI adapter on project-local copy, never silently import SES onto source board. Explicit Python/pcbnew DSN/SES bridge plus re-run KiCad DRC mandatory. Not installed for this change | GPL-3.0. Do not copy/link code into RWMCP without licensing review. Windows test machine has no Java executable on PATH |
| [mcp-server-kicad](https://github.com/ProductOfAmerica/mcp-server-kicad) | KiCad 9/10 tool surface, byte-preserving CST writes, schematic/PCB sync, project-safe copy autoroute using Freerouting | Keep RWMCP typed SHA-bound edits; improve S-expression AST robustness and cross-file validation. Borrow only design principles, not code | MIT. Inspected README, `mcp_server_kicad/pcb.py` snippets and LICENSE |

## Implemented in this branch

**New MCP action:** `kicad_autoexperiment_run` (Work Session owned, project-local output directory, expected source SHA-256):
1. Read authoritative original .kicad_pcb and baseline KiCad JSON DRC, optional schematic parity.
2. If typed alignment groups supplied, create up to three ranked placement candidates; blocked and HPWL-tradeoff candidates are not automatically executed.
3. Otherwise evaluate 1..3 route-only candidates: standard grid, finer grid and higher via penalty.
4. Write **separate PCB copies** inside new experiment directory, copy project .kicad_pro, same-stem .kicad_sch, local `fp-lib-table`, `sym-lib-table`, `*.pretty/*.kicad_mod`, `*.kicad_sym`, `*.kicad_dru` and `*.kicad_wks` under strict bounds and without symlinks.
5. Apply any candidate footprint positions only to an in-memory/copy file; no copper tear-up implicit.
6. Invoke existing obstacle-aware route planner and typed route batch on candidate board only, max 64 operations/trial.
7. Validate every copy using **official KiCad DRC** (and parity when schematic given). Reject if DRC violations/errors, unconnected or parity regress, or if unconnected does not strictly decrease.
8. Rank accepted candidates by fewest unconnected, fewest DRC violations, fewest new vias and shortest newly added track length. Emit `experiment-manifest.json` with SHA proof and hold reasons. **Never automatically promote to manufacturing.**

### Measured real V19 tests (not synthesized claims)

Source board SHA-256 unchanged:
`f7a5e1ba82b0c43b553c0bdac674b47735be46dffd88cc11b2f75c48d7cd1def`.
Original official DRC: **0 violations**, 85 unconnected, parity 0.
- Direct simple /A8 route with missing copied local footprint libraries: one fewer unconnected but 22 library warnings; correctly rejected.
- Corrected project-local library staging: /A8 routed, 6 straight segments, 0 new via, official DRC violations 0, unconnected 84, parity 0; copy accepted.
- 3 trial comparison for /A8:
  - Standard 0.5 mm grid: added straight copper 85.3945 mm, 0 via, 84 unconnected, 0 DRC violation.
  - Fine 0.25 mm grid: **79.5937 mm**, 0 via, 84 unconnected, 0 DRC violation; **selected**.
  - Higher via penalty: 85.3945 mm, 0 via, 84 unconnected, 0 DRC violation.
- Path: `Mega2560-Jack-Shield-V12/design/V12_2L/review/V19_FUNCTIONAL_COMPACT_WIP_20261014/review/RWMCP_AUTOEXPERIMENT_A8_3TRIALS_20261014/`.
- No original PCB, original application version or Windows service was modified.


## Incremental milestone: bounded multi-round DRC-targeted routing, 2026-10-14

`kicad_autoexperiment_run` now accepts `iterations`:
```json
{
  "maxRounds": 3,
  "maxNetsPerRound": 4,
  "autoSelectUnconnected": true,
  "includePowerNets": false
}
```
Every round:
1. Extract unconnected named nets from matching pad descriptions in the **official KiCad DRC JSON**, not invented PCB geometry.
2. Select no more than 24 bounded nets/round, avoid repeats, and never auto-route GND, IOREF, VCC/VIN, 3V3/5V, buck/eFuse/switching/return supply nets without an explicit `includePowerNets` override.
3. Run bounded 2-layer A* and apply typed segments/vias **in memory only**. Save each attempted round in a fresh project-local `candidate/round-NN` directory with copied project libraries/schematic.
4. Re-run official KiCad DRC and parity. Preserve only a round with **strictly fewer unconnected** and non-increasing active design violations/parity/errors. Roll back all failed rounds in the candidate's working source.
5. Carry forward accepted copper and re-read remaining unconnected net names; produce per-round trace, net list, before/after metrics, failure reasons, exact candidate and original SHA.

**Measured KiCad 10.0.6 V19 copy test:**
- Original authoritative PCB SHA: `f7a5e1ba82b0c43b553c0bdac674b47735be46dffd88cc11b2f75c48d7cd1def`, unchanged after run.
- Baseline official DRC: **85 unconnected, 0 active geometric violations, 0 schematic parity**.
- Round 1: nets A12/A13/A14/A15; 22 operations; official DRC unconnected 85 -> 82, 0 violations.
- Round 2: A8/D2/D22/D23; 27 operations; 82 -> 79, 0 violations.
- Round 3: D3/D34/D38/D39; 25 operations; 79 -> 76, 0 violations.
- Total **74 accepted routing operations**, **9 fewer unconnected items**, original unchanged, no manufacturing approval.
- Copy path: `Mega2560-Jack-Shield-V12/design/V12_2L/review/V19_FUNCTIONAL_COMPACT_WIP_20261014/review/RWMCP_AUTOROUTE_3PASS_20261014_V1/`.

Note: DRC may report a net still partially unconnected after one attempt; this bounded version deliberately avoids blindly retrying the same net repeatedly. Improving multi-terminal topology, deterministic targeted escape reattempts and rip-up/zone refill are separate subsequent engineering tasks.

No release-runtime update was carried out. Windows v0.70.0-dev.10 remains untouched, and this experimental branch requires CI/review before deployment.

## Engineering gates still open

1. KiCad 10 exact Edge.Cuts rounded polygon and true 3D/cable/mechanical-fit collision checks (current courtyard AABB only).
2. Project-level **automatic subcircuit grouping** (UART x12, PS2, L298, PWM, Input/Output) beyond explicitly declared groups.
3. Safe physical footprint legalizer and attached-copper rip-up/re-route/zone-refill on copies.
4. Multi-round unconnected-target routing and targeted pad/via escape strategies.
5. Full route topology, ground return, thermal and EMC checks; power buck/eFuse review and independent sign-off (TPS26600 RTN separation).
6. Optional isolated Freerouting DSN/SES bridge after Java availability and GPL/process integration review.
7. Complete all unconnected nets, run full clean KiCad ERC/DRC + parity, inspect 3D assembly, then gate Gerbers. None of this is implied by a single accepted experiment.

No third-party project code was copied into RWMCP; implementation uses original TypeScript and existing KiCad CLI.
