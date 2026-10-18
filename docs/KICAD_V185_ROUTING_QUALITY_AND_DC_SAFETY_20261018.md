# Windows KiCad quality milestone — Mega2560 V185 benchmark (2026-10-18)

## Contract
Source project (read-only): `Mega2560-Jack-Shield-V12/design/V12_2L/CAD_V185_FABRICATION_CANDIDATE_20261017`.
Board: `MegaPowerWIP_V185.kicad_pcb`.
Exact SHA-256: `6da153750d08a3a5e71557c5136a08c829f400a8c4d4b87addd0782408842c3e`.
Existing V185 ERC/DRC/unconnected/parity = 0 (KiCad native check). Retain original Gerber, geometry, schematic, electrical topology, BOM and power safety holds. No user PCB mutation, no runtime release deployment.

## Improvements
1. Single shared KiCad 10 named/numeric/mixed net resolver, now adopted by design review too; mixed tokens for one name are not double-counted.
2. Read-only same-layer straight-track endpoint graph identifies near-90-degree junctions and near-reversals, separately from legitimate 45-degree bends, with ranking by net. Branch and via nodes are excluded; it never calls these geometric candidates DRC violations or blindly autoroutes them.
3. Electrical review no longer treats all branches of a net as one series resistor carrying the full current. The DC computation is conditional on a simple connected two-terminal, track-only path with no via or zone and complete stackup copper thickness. No estimates when topology is branched, disconnected, looped, via-based, zoned or when copper thickness is unknown. Even an eligible track model is NOT a pad-to-pad/supply-to-load drop certification; injection/load positions, contacts, copper pours, parallel paths and thermal effects require dedicated modeling.
4. Electrical parsing rejects invalid net tokens on explicit segments, arcs or vias instead of silently returning incomplete evidence.

## Real-board evidence
`analyzeKicadDesign` on unchanged V185:
- 81 net groups, 971 straight segments, 130 through vias, 4,866.057 mm total explicit track.
- 56 segments <= 0.25 mm.
- 735 eligible two-segment same-layer junctions; 235 via-adjacent endpoints excluded; 7 branch nodes excluded.
- 17 near-90-degree junctions, 3 near-reversals and 635 diagonal/45-degree-range bends (evidence categories; endpoint angles only).
- First suggested review candidates include `/5V`, `/BUCK_5V`, `/D20_SDA`, `/VIN_PROTECTED`. None is an automatic edit directive.

`analyzeKicadElectrical` on the same board:
- `/BUCK_5V`: 114.1424 mm, 30 segments, 3 vias.
- `/VIN_PROTECTED`: 58.5468 mm, 16 segments, 2 vias.
- `/EFUSE_RTN`: 24.5871 mm, 21 segments, 4 vias.
- `/5V`: 392.3108 mm, 91 segments, 4 vias.
- All 4 return `dcPath.eligible=false`, no invented copper-only voltage drop, because vias/zones and physical copper stackup information cannot support a series-path estimate.

## Architecture and acceptance
- New `kicad-route-quality.ts`: pure geometric inference from typed endpoints only.
- New `kicad-dc-path-safety.ts`: pure fail-closed series-path topology guard.
- Existing `kicad-design-review.ts` and `kicad-electrical-review.ts` only consume helpers; no raw commands, file writes, or PCB mutation capabilities added.
- Targeted tests cover straight vs 90/45/reversal, via/branch exclusions, deterministic ranking, net token parity, branched/DC rejection, zone suppression, invalid copper syntax.
- Must pass TypeScript typecheck, architecture boundary check and full KiCad test suite before PR review; GitHub CI and Windows native acceptance before merge.
- Must NOT claim improved physical routing: only visibility, safety and review prioritization are delivered. Real optimization and routing via KiCad IPC/copied designs need separate DRC-gated acceptance.

## Next engineering work
Priority P1: placement-aware global route reservation; 45-degree detailed router; DRC-gated rip-up/re-route, via budget and high-fanout power-first strategy. Measure actual before/after *on copies* of V185 or independent fixtures with total track length, via count, DRC and unconnected deltas. 
Priority P2: per-branch power current, source/load assignment, source-backed component calculations (LM2596/TPS26600/eFuse), physical stackup, thermal/return path, connector clearance and manufacturing review.
