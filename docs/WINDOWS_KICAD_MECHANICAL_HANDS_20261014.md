# RWMCP Windows – KiCad mechanical hands upgrade (2026-10-14)

## Motivation

The prior agent could calculate row alignment and rectangular keepouts but could not distinguish the *actual* curved `Edge.Cuts` copper-board perimeter from a naive enclosing rectangle. It also lacked a user-reviewable **placement-only PCB copy**: the earlier `kicad_autoexperiment_run` required a strict decrease in unrouted items and therefore could not accept a harmless movement before re-routing.

This development remains Windows-only, based on PR #261. Deployed version `v0.70.0-dev.10` is untouched; Ubuntu/SSD/Vision are frozen. No original KiCad source is modified.

## Implemented capability

1. `kicad-board-outline.ts` reads real `gr_line`, `gr_arc` and `gr_rect` primitives specifically on native `Edge.Cuts`; traverses unordered/reversed endpoints, reconstructs a single closed boundary and conservatively samples circular arcs. Detects missing/open/multi-contour/unsupported `gr_poly`, `gr_circle` and `gr_curve` as **unverified**, never invented.
2. Rectangle–polygon validity checks footprint courtyard AABBs against the *true native boundary*, not only its enclosing box, with bounded optional `minEdgeClearanceMm`; connector-access corridors must also stay within the board unless explicitly declared as off-board.
3. `kicad_layout_optimize_plan` returns `boardMechanicalOutline` evidence: contour status, 4 arcs/4 lines, bounds, area and whether exact contour checking was applied. Ranked scenarios are independently rechecked so a candidate blocked by a curved edge cannot be auto-recommended.
4. `kicad_autoexperiment_run` gains **`previewPlacementOnly: true`**. Must supply explicit alignment groups; cannot run against an unverified native Edge.Cuts outline; requires the existing expected SHA and Work Session authorization.
5. For every eligible scenario, create a completely separate project-local KiCad PCB copy using bounded typed footprint moves, bring along original `.kicad_pro`, matching `.kicad_sch`, local `fp-lib-table`, `sym-lib-table` and `*.pretty` footprints; invoke **official KiCad DRC/parity** on that exact copy.
6. A placement-only preview may keep the number of unconnected items unchanged but must **never increase** DRC geometry errors, unconnected counts, severity errors or schematic parity. Reports include preview-only status, moved footprint references/coordinates, mechanical evidence and accepted/rejected reasons. No preview is promoted to the original, no Gerber is exported, no manufacturing approval is implied.
7. Existing full copy-only router behavior is unchanged unless the new opt-in flag is set.

### Example for grouped stepper connectors (review-only!)

```json
{
  "workspace": "projects",
  "projectPath": "Mega2560-Jack-Shield-V12/design/V12_2L/review/V19_FUNCTIONAL_COMPACT_WIP_20261014",
  "board": "Mega2560_Robotics_Jack_Shield_V12_2L.kicad_pcb",
  "schematic": "Mega2560_Robotics_Jack_Shield_V12_2L.kicad_sch",
  "outputDir": "review/MECHANICAL_PREVIEW_NEW",
  "expectedBoardSha256": "f7a5e1ba82b0c43b553c0bdac674b47735be46dffd88cc11b2f75c48d7cd1def",
  "previewPlacementOnly": true,
  "placement": {
    "fixedReferences": ["A1"],
    "alignmentGroups": [
      {"id": "stepper-jst", "axis": "row", "anchorReference": "J8", "references": ["J8", "J9"], "pitchMm": 16.5}
    ],
    "minCourtyardGapMm": 0.2,
    "minEdgeClearanceMm": 0.5,
    "maxSuggestedStepMm": 0.5,
    "placementGridMm": 0.5,
    "maxHpwlRegressionMm": 100
  }
}
```

### Verified Windows KiCad 10.0.6 V19 evidence

Original board SHA-256 before and after BOTH trials: `f7a5e1ba82b0c43b553c0bdac674b47735be46dffd88cc11b2f75c48d7cd1def`.

Native board perimeter: `X 20..143 mm`, `Y -12..115 mm`, **123 × 127 mm**, 4 straight lines, 4 round 4 mm corners, conservative area approximately **15,607.25 mm²**.

**Unsafe attempt** – alignment of output J13/J14/J15, bounded steps 1.5 / 3 / 5 mm, explicit wiring-proxy tolerance: KiCad real DRC indicated after moved J15: at least one violation (up to 5), unconnected **85 → 86**; all three placement previews were correctly **rejected**, no source mutation. Evidence: `review/RWMCP_MECHANICAL_PLACEMENT_PREVIEW_20261014_V1/`.

**Safe attempt** – grouped stepper connector alignment, J8 anchored at (81.5, 1), J9 moved **(98.5, 1) → (98, 1)**, A1 Mega footprint stayed (20, 22.66). Exact copy result:
`review/RWMCP_MECHANICAL_PLACEMENT_PREVIEW_20261014_V2/scenario-3/Mega2560_Robotics_Jack_Shield_V12_2L.kicad_pcb`

Accepted copy SHA-256: `f2c5318c36f2d8a6b27630bef4f1051add9855024192b543e7cdf79bc271ade5`, official KiCad DRC baseline **0 geometry violations / 85 unconnected / 0 parity** and candidate **0 / 85 / 0**. File validated independently using RWMCP's existing `kicad_edit_inspect` on the candidate PCB.

This verifies bounded physical *editing ability* while preserving the original, not complete PCB routing or electrical/mechanical signoff.

## Known safety holds / next production milestones

- Exact outline *sampling* is conservative (arc chords sampled at 0.15 mm); no full NURBS/STEP solid intersection, USB/DC/ICSP 3D mating, component body heights, wire insertion forces, thermal clearance or enclosure fit. User 3D validation remains required.
- A footprint without verified courtyard cannot be automatically placed. Unknown outline primitives/cutouts fail closed. Multi-footprint shared clearance requires review and official DRC.
- Moving pads with existing copper may create stale track endpoints; the output connector case intentionally failed DRC. Do not enable automatic acceptance without **routing updates on the copied board**.
- Mechanical constraints need owner-confirmed plug orientation and cable envelope, plus accurate Mega shield mating dimensions.
- Full V19 remains incomplete: **85 unconnected on original**. Historical separate autorouted candidate V19 reached 75 but was not promoted. Nothing here implies fabrication readiness.
- Next hands improvements: robust KiCad live editor state/IPC synch, code-reviewed automated copper rip-up/re-route for moved pads, zone refill, 3D mechanical inspection and functional-block placement manifests.
