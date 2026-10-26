# Windows RWMCP KiCad Agent: Native Edge.Cuts-safe routing

Date: 2026-10-14 | Parent: PR #263 / ea94475a | KiCad 10.0.6, Windows only

## Why this hand matters

RWMCP's prior A* autorouter limited search to a bounding rectangle derived from `gr_rect` or `gr_line`. A PCB may have rounded corners or inward notches where the bounding rectangle contains **no actual substrate**. The physical-placement module already reconstructed native KiCad `Edge.Cuts`, but the copper router did not use it. Trusting the rectangular envelope could produce bad geometries even when the planner claims a route is possible.

## Implementation

- `src/adapters/engineering/kicad-routing-boundary.ts`: reusable, bounded native copper routing envelope from the existing verified three-point circular arc + line + rectangle `Edge.Cuts` parser.
- Fail closed on no boundary, open outline, multiple contours/cutouts, unsupported shapes, self intersections or invalid bounds: **do not infer a safe board from a rectangle**.
- Use a point-in-polygon check and exact shortest distances to sampled native boundary segments; individual copper-center points must stay at least **`edgeInsetMm + track_width/2`** from the real board edge.
- For vias, enforce **`edgeInsetMm + via_diameter/2`** on all layers. Start and end pads must respect the same conservative inset for the new trace.
- Verify every straight routed operation as an entire line segment, not only its grid nodes, so a sparse-grid shortcut cannot traverse a concave missing-board region. Refuse unsafe candidate nets and return `outside-native-edgecuts` rather than emitting copper.
- Return measured native geometry in `kicad_route_plan.board`: `nativeOutlineStatus`, `nativeOutlineArcCount`, `nativeOutlineAreaMm2` and native min/max bounds.
- Retain CPU/state budgets, two-layer settings, original Work Session authority and SHA-bound DRC-gated copy-only experiment workflow.
- No direct write to user original PCB and no fabrication claim. Any differences in router geometry must still pass **official KiCad 10 DRC and optional schematic parity on an isolated project-local PCB copy**.

## Upstream engineering context

[Freerouting](https://github.com/freerouting/freerouting) provides an advanced Specctra DSN/SES autorouter with CLI and KiCad integration. Its [official KiCad plugin](https://github.com/freerouting/freerouting/blob/master/integrations/KiCad/README.md) explicitly designates **DSN** as the recommended production path and calls its JSON/API mode experimental. KiCad 10's [pcbnew API](https://docs.kicad.org/doxygen-python-10.0/namespacepcbnew.html) provides `ExportSpecctraDSN(BOARD, file)` and `ImportSpecctraSES(BOARD, file)`. Future optional Freerouting bridge should use KiCad's trusted DSN/SES bridge and only operate against an isolated copy, with official DRC after import. Do not copy Freerouting GPL source into RWMCP. On the acceptance Windows workstation, **Java was not present on PATH**; no Freerouting execution or DSN/SES import was attempted or claimed here.

## Official Windows acceptance (not simulated)

Source V19 board SHA-256 before and after both experiments:
`f7a5e1ba82b0c43b553c0bdac674b47735be46dffd88cc11b2f75c48d7cd1def`.

File: `Mega2560-Jack-Shield-V12/design/V12_2L/review/V19_FUNCTIONAL_COMPACT_WIP_20261014/Mega2560_Robotics_Jack_Shield_V12_2L.kicad_pcb`.

1. **Net A8**: new real KiCad board candidate in `review/RWMCP_NATIVE_OUTLINE_ROUTING_20261014_V1/routing-only/`. 6 routing operations were inserted. Official KiCad DRC: unconnected **85 -> 84**, active non-unconnected geometry violations **0 -> 0**, schematic parity **0 -> 0**. Wall-time approximately 6.0s including baseline/final DRC and artifact staging.
2. **Bounded 4-pass route automation**: new real KiCad copy in `review/RWMCP_NATIVE_OUTLINE_MULTIPASS_20261014_V1/routing-only/round-04/`. **82 typed route operations accepted**. Official KiCad DRC unconnected **85 -> 75**, non-unconnected geometry violations **0**, parity **0**, source unchanged. Wall-time ~67.0s for all rounds, including official KiCad DR C checks. This is NOT a completed PCB.
3. Synthetic contour regressions: (a) 4-arc board rejects point inside rectangular box but beyond corner; (b) A* routes a legal net on the 4-arc board without any segment or via crossing the curved edges; (c) an open path is refused, (d) a concave PCB rejects segments directly crossing its missing-board notch; and (e) real A* re-routes around that notch instead of crossing it.

## Limitations / next priority

- Conservative tessellation: arcs are approximated in the existing source-authoritative outline parser with roughly 0.15mm chord steps. KiCad's own DRC is still authoritative. Do not substitute this check for a 3D mechanical/copper-to-edge or manufacturing evaluation.
- Multi-contour/hole outlines deliberately fail closed until hole-specific geometry, disjoint shell recognition and clearance are implemented.
- The A* router currently routes two copper layers with approximate grid clearance; high-speed differential, RF/DDR, mixed-voltage return currents, eFuse/TPS26600, LM2596 hot loops and thermal performance require dedicated engineering.
- Exact DSN/SES professional autorouting integration, native zone refill after footprint moves, full route-rip-up and anti-stagnation solver orchestration remain open.
- All work is source branch only. Active Windows RWMCP remains `v0.70.0-dev.10`; Ubuntu, SSD and Vision development remains frozen. Do not release or modify the production runtime until later approved.
