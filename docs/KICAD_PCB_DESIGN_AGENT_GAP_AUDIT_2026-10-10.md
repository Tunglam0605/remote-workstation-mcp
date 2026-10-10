# KiCad PCB Design Agent — engineering gap audit

**Scope:** Source from published RWMCP v0.70.0-dev.7, plus an isolated routing hardening worktree. This is a framework audit, not acceptance of customer electronics or approval to fabricate a board.

## Evidence obtained on 2026-10-10

- KiCad CLI 10.0.6 authoritative ERC/DRC: the isolated 2-component completed sample was clean (ERC/DRC/parity/unconnected = 0), accepted by the manufacturing gate, with BOM, assembly coordinates, STEP, and SHA-256 manifests. A synthetic STM32F103 LQFP-48 / dual-L298 / PS2 fixture was blocked from manufacturing because 55 unconnected and 2 dev6 field-parity warnings remained.
- Previously accepted five functional routes on the isolated STM32F103 fixture: PS2_ATT, PS2_CLK, PS2_CMD, PS2_DAT, M3_PWM. That proves typed route batch and KiCad DRC rollback constraints, **not** full board autorouting.
- Current isolated source routing hardening passes 40/40 focused KiCad tests. Benchmark on the same partly routed fixture flags M3_PWM as `already-connected`; attempts to route M1_PWM/M2_PWM/M4_PWM still reach the 20-second search budget with no new accepted route. All benchmark probes are **read-only** and are not performance guarantees.

## Correctness fixes in development

1. **Real copper vs assembly courtyards.** Do not treat `F.CrtYd/B.CrtYd` as copper keepout polygons. Use actual foreign-net pads, existing tracks/vias, and planned copper as obstacles; keep clearance checks. Keepout/rule-area geometry is not modeled yet: stop candidate routing if KiCad forbids track or via in a zone, instead of silently generating unsafe routes. Authoritative KiCad DRC remains mandatory.
2. **Via clearance.** A via centered on the source/target pad is not exempt from existing foreign-net copper or foreign-pad checks on *either* copper layer.
3. **Conservative existing connectivity.** Detect already completed net paths only when exact pad-center, track-segment endpoint and through-via connections can be proven. Mark `already-connected` without spending A* search budget; do not infer arbitrary mid-track tees or nearby copper as an electrical connection.

## Capabilities that remain below professional autonomous PCB expectations

| Area | Present implementation / verified limitation | Next acceptance gate |
| --- | --- | --- |
| STM32 pin assignment | Typed MCU pin planning and schematic/board consistency tests exist. | Package + alternate-function legality, oscillator/boot/debug/power, voltage domain, ADC and peripheral remap constraint report for every MCU selection. |
| Schematic quality | Synthesizes netlist-mapped KiCad symbols, 50-mil alignment, ERC/netlist comparisons. | Multi-sheet logical hierarchy, functional blocks and reviewable power/decoupling conventions with explicit annotation/BOM readability tests. |
| Mechanical/semantic placement | MCU anchor, connector edge, weighted-neighbor centroid; spacing retries. | Floorplan partitions, hard keep-in/keep-out areas, local orientation/pad escape scoring, 3D collision, enclosure/connector and thermal penalties. |
| Fine-pitch routing | A* orthogonal 2-layer grid, 0.25-mm auto grid with bounds, corridor retries, net-aware clearance, strict 20-second budget; partial connectivity now recognized conservatively. | Pitch-aware BGA/LQFP pin-escape lanes, 45-degree geometry, spatial-cost cache, reroute/rip-up rollback, incremental existing net graph, multi-net conflict arbitration. |
| Copper zones/keepouts | Authoritative DRC gate exists; keepout rule areas currently trigger safe refusal in isolated new source. | Parse track/via bans per layer and exact polygon geometry, copper plane/return path, thermal relief, filled-zone connectivity; rerun official refill/DRC. |
| Power/EMI/high-speed | High-speed/SI/EMI claims explicitly deferred; no automated proof of impedance, return-path or thermal constraints. | Independently validated PDN/stackup, controlled impedance, diff-pair spacing/skew, ESD and decoupling placement from manufacturer data. |
| Manufacturing QA | Clean ERC/DRC/unconnected/parity and position/BOM gates, hash manifest and 3D/STEP; positive and negative tests. | Library footprint/courtyard and 3D model audit, clearance and drill capabilities per fab, soldermask/paste, test-point coverage, DFM/DFT signoff. |

## Strict release/acceptance policy

- **P0:** Never fabricate or generate production output with unconnected copper, ERC errors, DRC errors, schematic parity regressions, unknown keepout constraints, or unapproved electrical assumptions. Source-generated routes must pass typed, SHA-bound KiCad validation and rollback-on-regression.
- **P1:** Implement compact pre-route pad-escape and small-net incremental graph, then rerun the same saved STM32F103 baseline and measure newly *accepted* wires; route-generation counts alone do not count as acceptance.
- **P2:** Add collision-aware placement refinement and cost scoring, then compare area, wirelength, crossings and DRC by identical BOM/board constraints. Preserve the schematic/netlist and exact pad map.
- **P3:** Add controlled specialist intent packs (USB, CAN/RS485, motor power, analog) with manufacturer datasheets and solver/review flags; do not invent signal-integrity compliance.

**Decision:** RWMCP dev.7 is a useful typed, guarded KiCad engineering assistant for constrained/sample boards. It is not yet a professional, fully automatic schematic-to-manufacturing system for a dense STM32 robot controller. Continue in development branch; no deployment or touch of real board/hardware during framework work.
