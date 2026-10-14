# KiCad agent audit — Windows RWMCP v0.70.0-dev.10 — 2026-10-14

## Scope and sources
- Runtime: Windows workstation `TungLamAutomation`, KiCad CLI 10.0.6, kicad-python 0.8.0 available; live GUI IPC currently not connected. Preserve active runtime and production project.
- Reference projects: [atoplace](https://github.com/glovepost/atoplace), [KiCraft](https://github.com/laforestlabs/KiCraft), [Freerouting](https://github.com/freerouting/freerouting), [mcp-server-kicad](https://github.com/ProductOfAmerica/mcp-server-kicad). Feature claims originate from their respective repository documentation; integration and licenses need independent review.
- Real-world acceptance case: `Mega2560-Jack-Shield-V12/design/V12_2L/review/V19_FUNCTIONAL_COMPACT_WIP_20261014`. WIP; **not fabrication-approved**. Do not overwrite active PCB.

## Baseline problems revealed by direct KiCad verification
- V19 (sha256 `f7a5e1ba82b0c43b553c0bdac674b47735be46dffd88cc11b2f75c48d7cd1def`): KiCad ERC 0, geometric DRC violations 0, **85 unconnected copper**; schematic parity 0.
- Geometry: 123 × 127 mm, 37 footprints, 251 pads, 395 explicit segments, 43 vias, ~3749.34 mm routed track length.
- Previous layout optimizer incorrectly returned 0 connected pads and 0 nets, while design review recognized routing on the same file.
- Root cause: optimizer only parsed `(net 1 "NAME")` / `(net 1)`; KiCad 10 `pcbnew` serializes named-only `(net "/NAME")`.
- V18's historical clean ERC/DRC report was bound to a different PCB SHA than the current file; do not reuse stale evidence to approve revised CAD.

## Change implemented in this branch
- Analyzer now accepts named-only, numeric, and mixed KiCad board net declarations.
- Missing numeric KiCad net IDs get deterministic **negative in-memory IDs**, used for read-only analysis, never written to PCB.
- Named pad declarations, segments, arcs, and vias share one resolver.
- Regression tests for named-only and mixed encoding. Existing numeric tests remain passing.
- Real V19 smoke result after fix: 235/251 connected pads; 97 nets; 48 routed-net efficiency comparisons; 234/234 schematic netlist pins match board pad nets, 0 missing, 0 mismatches.
- Automated bounded geometric placement candidates and detour rankings now work. The read-only MCP tool now supports an explicit `fixedReferences` list to exclude named footprint anchors from movement suggestions; this does NOT lock PCB geometry or replace mechanical DRC. Example for the Mega shield: `["A1"]`.
- Focused test suite: 37/37 passing after the follow-up constraint change; TypeScript typecheck PASS; architecture boundary check PASS.
- No new tool installation, release, runtime restart or user PCB modification.

## Lessons applied from external agents (architecture, not unreviewed code copying)
1. **atoplace — constraint-first legal placement**: Explicit locked anchors (Arduino Mega headers, mounting holes, USB/DC/ICSP clearance envelope), functional block clustering, accessibility, grid alignment, edge orientation and courtyard collision checks **before** minimizing net span. Provide explainable candidate diff rather than directly moving user footprints.
2. **KiCraft — iterative experiments**: Run bounded alternative placement/routing rounds on immutable board snapshots; score not just total HPWL but unrouted connections, electrical safety, vias, overall track length, congestion, board area, manufacturing rules and connector/mechanical constraints. Promote the best only after fresh KiCad ERC/DRC/parity and matching board SHA. Never rank an electrically invalid layout above a valid one for aesthetic reasons.
3. **Freerouting — specialized routing**: Experiment with standard KiCad Specctra DSN/SES export/import in a disposable worktree/PCB copy. Compare with RWMCP A* router under identical net classes and geometry. Treat JSON REST bridge as experimental. Reject changed pin-net assignments, copper violations, missing ground returns and unconnected regressions.
4. **mcp-server-kicad — tool separation**: Preserve the RWMCP typed adapter/service split, library resolution, transaction/rollback, official KiCad verification and single source of truth for EDA file mutations. Do not add a second uncoordinated MCP actor writing to the same board.

## Proposed Windows-only implementation gates
- **P0 — parsing and evidence [this branch]**: Merge KiCad 10 parser regression with real-file smoke; add round-trip SHA-bound report generation and refuse historical mismatched acceptance.
- **P1 — semantic placement [partial: explicit fixedReferences implemented; full legalizer not implemented]**: Add project-scoped typed constraint manifest: `fixedReferences`, `functionalGroups`, `edgePreferred`, `keepouts`, `clearanceEnvelopes`. Never move Mega shield anchor or header mating geometry unless explicitly released. Add legalizer with orientation/courtyard and mounting-holes verification; keep old plan in read-only mode by default.
- **P1 — buck/industrial DFM [not implemented]**: Source-backed checklist for switching hot loop, return current, RTN isolation, input/output bypass, thermal EP/stencil and derating. Datasheet pin mapping and 3D mating are separate acceptance gates from KiCad DRC. Electrical topology changes require source and netlist review.
- **P2 — ranking and routing [not implemented]**: Add deterministic score components and experiment ledger with board SHA, route length, via count, unconnected, congestion, violations, board area and physical-rule holds. Add Freerouting as optional isolated provider with validated DSN/SES parity.
- **P2 — interactive visual review [not implemented]**: Restore/verify official KiCad IPC with an open PCB Editor, then publish before/after 3D, top/bottom, placement delta and a human acceptance checklist. Do not silently enable live writes.

## Release acceptance
- Synthetic numeric and KiCad10 named/mixed regression fixtures.
- Real V19 netlist parity and no source mutation; unchanged KiCad ERC/DRC baseline.
- No stale QA reuse, no unapproved Gerber, no automatic release of PCB for manufacturing.
- Keep deployed `release/windows-v0.70.0-dev.10` unchanged until independent test/PR review; Ubuntu frozen.

## Implementation milestone: constraint-first grouped placement (2026-10-14)

A read-only `kicad_layout_optimize_plan` upgrade implements the first Windows-only P1 constraint layer:
- `alignmentGroups`: 2..64 footprint references per group, explicit `axis` row/column, optional `anchorReference`, optional center-to-center `pitchMm`. Anchor remains unmoved and group members are processed deterministically.
- `fixedReferences`: protect mechanical references from proposed moves (pre-existing feature).
- `keepouts`: up to 64 user-declared rectangular no-placement regions in absolute PCB millimeters.
- `boardBounds`: optional explicit rectangular review envelope. **This does not represent a precise rounded Edge.Cuts polygon.**
- `minCourtyardGapMm`: conservative spacing against parsed KiCad F/B.CrtYd footprints, circles, lines and rectangles; unknown arc/poly courtyard geometry causes a blocked candidate.
- Read-only result `constraintPlacement`: groups, current/target/bounded intermediate coordinates, blockers, review notes and proposal counts.
- Legacy connectivity-only centroid moves are suppressed if constraints are provided; never confuse centroid suggestions with collision-legal movements.
- A candidate marked `review` is NOT a verified legal placement: moving a component invalidates current copper. Any real mutation requires fresh routing, KiCad DRC, ERC, schematic parity, electrical and connector/assembly review.
- Fixed anchors and group topology are advisory through this typed tool; no IPC/live PCB or file edits occur.

Example request payload (use board path relative to the selected project):
```json
{
  "workspace": "projects",
  "projectPath": "Mega2560-Jack-Shield-V12/design/V12_2L/review/V19_FUNCTIONAL_COMPACT_WIP_20261014",
  "board": "Mega2560_Robotics_Jack_Shield_V12_2L.kicad_pcb",
  "fixedReferences": ["A1"],
  "alignmentGroups": [
    {
      "id": "output-connector-row",
      "axis": "row",
      "anchorReference": "J13",
      "references": ["J13", "J14", "J15"]
    }
  ],
  "minCourtyardGapMm": 0.2,
  "maxSuggestedStepMm": 5,
  "runRuleChecks": true
}
```

Real PCB V19 dry run (SHA-256 f7a5e1ba82b0c43b553c0bdac674b47735be46dffd88cc11b2f75c48d7cd1def): 37 footprints, 251 pads, 235 connected pads, 97 nets. J15 currently (59.5,86.75), target y=102 matching J13; bounded candidate y=91.75 at exactly 5 mm. Group produces 1 review-only suggestion, 0 allowed writes. The SHA-256 was unchanged before/after. Other footprint(s) lack court yards: professional mechanical verification remains mandatory.

Acceptance evidence:
- 47/47 focused KiCad tests passing across acceptance, design review, routing, layout optimizer and placement constraints.
- TypeScript typecheck and architecture boundary validation passing.
- All new code is in the isolated worktree `remote-workstation-mcp.kicad10-layout-parser-20261014`.
- Remaining P1 work: physical mating-envelope checks beyond footprint courtyard (Mega USB/DC, ICSP, cable bend and header orientation), connector-edge alignment legalizer, continuous DRC-gated copy-based experiments, and curved exact Edge.Cuts containment.
- Current runtime stays v0.70.0-dev.10 until feature is reviewed/merged/released. No automated manufacturing approval.
