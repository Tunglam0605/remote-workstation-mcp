# Windows KiCad — deterministic local routing review coordinates (2026-10-18)

## Purpose
Layer an evidence-only local-geometry stage atop the existing routing turn summary. This prepares future DRC-gated track editing while respecting the "never silently reroute live PCB" invariant. No shell tool, new permissions, manufacturing approval, or firmware/Ubuntu changes are introduced.

## Implementation
- Carry optional `widthMm` from KiCad PCB segments into the pure routing-turn analyzer.
- For eligible, distinct same-net/same-layer two-segment junctions (excluding via/branch nodes), provide bounded `topJunctions` with `netName`, `layer`, exact `at` (PCB mm), `bendDegrees`, segment indices, and equal-width evidence.
- For near-exact 90-degree, equal-width, sufficiently long two-segment corners, return a **geometric preview only** of replacing corner with a 45-degree chamfer. Offset is capped by 1 mm and one quarter of each adjoining segment length. Theoretical trace length saving is `(2 - sqrt(2)) * cutback` for an exact orthogonal corner. Coordinates are rounded for display and must NOT be interpreted as DRC-validated geometry.
- Mark equal-width collinear two-segment joints as possible fragmentation for review; do not label them electrically incorrect. Return a bounded `topCollinearJoins`.
- Deterministic sorting: reversals, right-angle candidates; then net, layer, X and Y. No footprint IDs or track UUIDs are synthesized, and index values are read-only source-order evidence only.

## Real KiCad 10.0.6 V185 benchmark (read-only)
File `Mega2560-Jack-Shield-V12/design/V12_2L/CAD_V185_FABRICATION_CANDIDATE_20261017/MegaPowerWIP_V185.kicad_pcb`
SHA-256 `6da153750d08a3a5e71557c5136a08c829f400a8c4d4b87addd0782408842c3e` (unchanged).

- 81 analyzed net groups; 971 straight segments; 130 vias; 17 near-90-degree junctions; 3 near-reversals; 36 collinear equal-width candidate joins.
- Example /BUCK_5V on F.Cu at (127.0000, 58.7500) is a reverse-junction review candidate; /D10 on F.Cu at (111.5000, 119.2500) is a right-angle review candidate.
- Prior report had aggregate counts and per-net rankings but no point coordinates. New report gives exact inspection points.

## Safety
Coordinate candidates are NOT authorization to modify copper. Their validity depends on pads, zones, copper-to-copper clearance, keepouts, via envelopes, return-path and current distribution, none of which is independently enforced by this pure geometry helper. KiCad ERC/DRC and schematic parity remain required after any later edits, with before/after source hashes and manufacturing hold until approved.

## Acceptance gates
- 16/16 focused design review + route-quality tests pass.
- 209/209 full KiCad regression tests pass.
- TypeScript typecheck PASS; architecture boundary check PASS.
- V185 read-only smoke PASS, source SHA unchanged.
- Continue with copy-only targeted chamfer/rip-up experiments with official DRC and nonregressing unconnected counts, not immediate live source edits.
