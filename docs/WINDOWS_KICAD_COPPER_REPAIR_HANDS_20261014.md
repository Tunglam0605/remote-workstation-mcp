# Windows RWMCP KiCad Hands: Copy-only Pad-Copper Endpoint Repair

**Date:** 2026-10-14 | **Parent:** PR #262 / `3e84c8d` | **Scope:** KiCad 10, Windows only; production runtime unchanged.

## Engineering problem

Moving footprint pads may invalidate already-routed segment endpoints. The earlier `previewPlacementOnly` workflow moved a footprint on an isolated board copy, but correctly rejected a copy if official KiCad DRC grew worse. To make an actual robotic editing hand rather than only a refusal gate, this milestone reanchors **only provably direct signal-net straight-track endpoints** to a moved footprint pad.

## New opt-in flag

Existing Work Session-owned MCP tool `kicad_autoexperiment_run`:

```json
{
  "workspace": "projects",
  "projectPath": "Mega2560-Jack-Shield-V12/design/V12_2L/review/V19_FUNCTIONAL_COMPACT_WIP_20261014",
  "board": "Mega2560_Robotics_Jack_Shield_V12_2L.kicad_pcb",
  "schematic": "Mega2560_Robotics_Jack_Shield_V12_2L.kicad_sch",
  "outputDir": "review/NEW_NONEXISTING_COPPER_REPAIR_EXPERIMENT",
  "expectedBoardSha256": "f7a5e1ba82b0c43b553c0bdac674b47735be46dffd88cc11b2f75c48d7cd1def",
  "previewPlacementOnly": true,
  "repairAttachedTracks": true,
  "placement": {
    "fixedReferences": ["A1"],
    "alignmentGroups": [{"id": "stepper-jst", "axis": "row", "anchorReference": "J8", "references": ["J8", "J9"], "pitchMm": 16.5}],
    "minEdgeClearanceMm": 0.5,
    "minCourtyardGapMm": 0.2,
    "maxSuggestedStepMm": 0.5,
    "placementGridMm": 0.5,
    "maxHpwlRegressionMm": 100
  }
}
```

All request paths must resolve under the authorized project root; `expectedBoardSha256` remains mandatory; the output folder must not already exist. **Without** `repairAttachedTracks: true`, placement behavior is unchanged.

## Safety contract

1. Rank mechanical alignment scenarios against **native Edge.Cuts**, rounded corners, courtyard and connector-access constraints; skip blocked/tradeoff scenarios.
2. Read PCB source and match exact reference, original footprint origin, net identity, source pad local offset and footprint rotation.
3. Restrict each footprint's translation to **≤3 mm**, 1..16 moved footprints, PCB ≤32 MiB, ≤4,096 pads, ≤16,000 straight copper segments. Reject locked tracks, ambiguous multi-segment junctions, touching vias, unsupported/locked pads, power and return nets, stale positions, and uncertain mid-segment contacts.
4. Reject any `(zone ...)` board until a KiCad-authoritative zone-refill procedure is available. **Never** silently change filled-zone geometry or power return paths.
5. Only replace the endpoint coordinate of the **single same-net straight copper segment** whose endpoint coincides with a moved pad's original center. No net renumbering, whole-net copper deletion, pin swap, via relocation or unapproved geometry rewrite.
6. If *any* guard blocks a candidate, reject all proposed copper edits for it (no partial copper commits).
7. Apply footprint moves and endpoint edits **in memory**, write a distinct project-local PCB copy with copied KiCad schematic/project/footprint libraries, then run **official KiCad DRC and parity**.
8. Accept placement-only candidate only if error count, active DRC violations, unconnected count and schematic parity **do not increase**. Return source/candidate SHA, before/after footprint positions, adjusted endpoint count, changed net names and rejection reasons.
9. The parent PCB is never written, no manufacturing outputs are produced, and 3D assembly/thermal/EMC/return-path acceptance remains separate. This is not an unconstrained rip-up-and-reroute algorithm.

### Native KiCad 10.0.6 Windows V19 acceptance

Original source SHA before and after:

`f7a5e1ba82b0c43b553c0bdac674b47735be46dffd88cc11b2f75c48d7cd1def`

V19 has **395 original straight copper segments**, no via, arc or copper zones in this WIP baseline.

- J9 connector translated **(98.5 mm, 1 mm) → (98 mm, 1 mm)** on **copy only**.
- Three exact signal pad endpoints were repaired: nets **`/D24`, `/D25`, `/D43`**; **3 segments, 3 pad endpoints**.
- Native KiCad DRC baseline **0 non-unconnected design violations, 85 unconnected, 0 schematic parity**.
- Candidate DRC **0 violations, 85 unconnected, 0 parity**. Accepted scenario `scenario-3`, held only as a review copy.
- Candidate copy: `review/RWMCP_COPPER_ENDPOINT_REPAIR_J9_20261014_V1/scenario-3/Mega2560_Robotics_Jack_Shield_V12_2L.kicad_pcb`.
- Candidate SHA: `62173ccde31daf0b70b34456518264ec0c24286ad8674557fc1b494cf91b75c9`.
- Other ranked hypotheses were blocked by placement checks; not executed.

### Important remaining capabilities

- **Actual rip-up/re-route** on edited net branches not anchored at a unique pad-center endpoint.
- Native KiCad **zone refill** after moving pads/tracks, with repeat DRC and copper connectivity check.
- Multiple endpoints/junctions, PTH/via behavior, bent tracks, differential pairs and power return paths.
- 3D enclosure/mechanical mating of Mega2560, JST plug-extraction envelopes, USB/DC barrel, ICSP, LM2596/eFuse thermal and ground return.
- Full two-layer V19 route completion and manufacturing verification (original still has 85 unconnected; separate autoroute experiments never promoted).

**Do not release a claim of autonomous production-ready PCB design based on this milestone.**
