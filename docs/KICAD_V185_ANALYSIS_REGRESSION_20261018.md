# KiCad 10 named-net analysis reconciliation — Windows-only regression (2026-10-18)

## Goal and safety boundary
Correct a demonstrated RWMCP design-analysis contract mismatch without changing the user's Mega2560 PCB, KiCad runtime, release slots or Ubuntu code. Code is staged only in the isolated Windows worktree on `fix/windows-kicad10-analysis-net-reconcile-20261018`.

## Reproduction (Windows RWMCP v0.71.0 stable; read-only)
Original board: `Mega2560-Jack-Shield-V12/design/V12_2L/CAD_V185_FABRICATION_CANDIDATE_20261017/MegaPowerWIP_V185.kicad_pcb`
PCB SHA-256: `6da153750d08a3a5e71557c5136a08c829f400a8c4d4b87addd0782408842c3e`.

Official KiCad 10.0.6 checks: ERC 0, DRC 0, unconnected 0, parity 0; 5 ignored checks are not silently equivalent to independent physical sign-off.

| Read-only tool | Before fix | After fix in isolated worktree |
| --- | --- | --- |
| Design review | 971 track segments / 130 vias | Reference (not changed) |
| Constraints review | 0 segments / 0 vias / 0 routed nets | 971 / 130 / 81 |
| Copper zones with recognized net | 0 / 234 | 234 / 234 |
| Electrical review /BUCK_5V | false `net-not-routed` | 114.1424 mm, 30 segments, 3 vias |
| Electrical review /VIN_PROTECTED | false `net-not-routed` | 58.5468 mm, 16 segments, 2 vias |
| Electrical review /EFUSE_RTN | false `net-not-routed` | 24.5871 mm, 21 segments, 4 vias |
| Electrical review /5V | false `net-not-routed` | 392.3108 mm, 91 segments, 4 vias |

## Root cause
The electrical and constraint modules parse only numbered references `(net 12)` plus `(net 12 "NAME")`; KiCad 10 uses named-only copper references such as `(net "/BUCK_5V")`. Other review tools already handle named-only references, so consumers silently disagreed.

## Fix scope
- Add a single read-only board-net resolver with deterministic in-memory negative IDs for named-only nets, retaining existing numeric and mixed legacy formats.
- Reuse that resolver in the electrical review and constraints review (tracks, vias, copper zones), without altering source PCBs or the file schema.
- Add automated tests for named-only and mixed net references in both consumers.
- Report `copper-thickness-unknown` when a current has been specified but no PCB stackup copper thickness exists, instead of silently suggesting an evidence-free DC estimate.

## Engineering limitations and next milestones
- The V185 board does **not** declare copper thickness in Board Setup. Do not claim validated DC drop, temperature rise or power capacity from these tools.
- Net-total track length is not source-to-load trace length in a branched network. Before adding 5V/2A sizing automation, build connectivity/path topology and per-branch load assignments; do not sum all branch resistances as series.
- No automatic IPC-2152 ampacity, field-solved impedance, transient buck loop analysis, return-path EMC signoff or assembled-board qualification.
- Route optimizer must use preplacement constraints: locked mechanical anchors, JST plugging clearance, grouped alignment, footprint/edge courtyard checks, via/congestion budget, route-quality score and rollback if DRC or unconnected count regresses.
- Keep prior V185 release files, source SHA, Gerber and assembly documentation immutable until the owner explicitly approves another iteration; run further experiments only on isolated copies.

## Acceptance
- Focused KiCad electrical/constraints unit tests after fix: 10/10 pass.
- Real V185 read-only smoke: route and zone figures above agree with design review; no production PCB modification.
- Typecheck, architecture validation and wider CI are separate gates. This worktree is **not released**, and production runtime v0.71.0 remains unchanged.
