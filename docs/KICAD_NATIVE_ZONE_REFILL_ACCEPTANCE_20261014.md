# RWMCP Windows KiCad 10 — Native Copper Zone Refill Hand

2026-10-14 | Parent: PR #266 | **Windows development branch only — not released**

## Engineering change

New Work Session-owned `kicad_zone_refill_copy` tool for the previously unsupported copper zone refill step. This lets an agent recreate filled copper polygons *after* an operator-approved geometric PCB change without directly altering the original board.

### Request contract

```json
{
  "workspace": "projects",
  "projectPath": "Mega2560-Jack-Shield-V12/design/V12_2L/CAD",
  "workSessionId": "OWNED_WORK_SESSION_UUID",
  "board": "Mega2560_Robotics_Jack_Shield_V12_2L.kicad_pcb",
  "schematic": "Mega2560_Robotics_Jack_Shield_V12_2L.kicad_sch",
  "outputDir": "NEW_ZONE_REFILL_PREVIEW",
  "expectedBoardSha256": "EXACT_64_CHAR_SHA256_OF_SELECTED_SOURCE"
}
```

1. Require full, exact SHA-256 proof and authorized Windows workspace; reject symlink source and path traversal, and do not overwrite an existing directory.
2. Run KiCad official baseline DRC and optional schematic parity on the selected board.
3. Stage a fresh isolated copy of the PCB, schematic, project settings, footprint and symbol libraries. Locate packaged official KiCad 10+ Python.
4. Call **`pcbnew.ZONE_FILLER(board).Fill(board.Zones())`** on the staged board only. Require ≥1 ordinary copper zone (not just no-copper rule areas), reject unsupported or oversized board/zone count.
5. Compare stable **KIID.AsString()** footprint/pad/track/zone and Edge.Cuts identities, coordinates and zone outlines before/after fill. Never use `str(KIID)`, which produces a SWIG proxy repr containing memory addresses instead of persistent UUID text. Via widths use `PCB_VIA.GetWidth(layer)` while track widths use `PCB_TRACK.GetWidth()`.
6. Save a new `.kicad_pcb`, reload in KiCad, verify non-fill design identity again and collect before/after native filled-zone area.
7. Run independent official KiCad CLI DRC/parity on the saved copy. **Accept a review-only candidate only if** active design violations/errors/unconnected/parity do not increase. A fill may maintain, improve or sometimes alter ground return; electrical/EMI/manufacturing approval remains separate.
8. Publish exact source/candidate SHA, KiCad version, zone count/area evidence and official before/after DRC into `zone-refill-manifest.json`. Source PCB is never saved.

## Actual KiCad 10.0.6 Windows acceptance

Project: `Mega2560-Jack-Shield-V12/design/V12_2L/CAD` — an archived **pre-V19 Shield board** containing one `/GND` zone on `B.Cu`. It is NOT the current Shield V19 geometry.

**Case A — already-filled source:** Running on a copy of the old CAD board did not introduce any changes. PCB source SHA unchanged (`e964aead43eb3fc77bb0b12780be9566b3bdefefd877067e66b2ba7d2bb51d83`), zone filled area unchanged at approximately `8.034e15` internal KiCad squared-unit values. Official DRC: **0 non-unconnected violations**, **15 → 15 unconnected**, **0 parity**. Accepted as a refresh preview. Copy in `CAD/RWMCP_NATIVE_ZONE_REFILL_20261014_V6/`.

**Case B — deliberately unfilled independent fixture:** Used native `ZONE.UnFill()` on a separate copy in `CAD/RWMCP_ZONE_UNFILLED_SOURCE_20261014/`, while preserving the older CAD source. The unfilled source SHA was `d6089b6e448b77e832d05c1ebc265a42e04fdc712164fb193dd5086bdb25b65e`.

Re-running the new RWMCP refill hand on that unfilled PCB recreated the original filled ground polygon:
- Zone fill before: **0**; after: **8.034029836099516e15** raw KiCad squared units.
- Official KiCad DRC: **37 → 15 unconnected**; **0 → 0 non-unconnected violations**, **0 → 0 schematic parity**.
- Source SHA unchanged; restored candidate SHA `e964aead43eb3fc77bb0b12780be9566b3bdefefd877067e66b2ba7d2bb51d83`, exactly matching the original archived board.
- Candidate: `CAD/RWMCP_ZONE_UNFILLED_SOURCE_20261014/RWMCP_NATIVE_ZONE_REFILL_ACCEPTANCE_20261014_V1/Mega2560_Robotics_Jack_Shield_V12_2L.kicad_pcb`.
- This is a genuine KiCad **fill creation** with official DRC improvement, not just a no-op or synthetic test.

### Unit acceptance

Tests cover stale source SHA refusal, output overwrite/traversal protections, acceptance on a copy with mocked native KiCad + DRC improvement and refusal when a mocked DRC result regresses. Unit mocks are labeled distinctly from real native KiCad acceptance.

## Remaining hands before reliable fully autonomous PCB release

- Full Freerouting Java/portable runtime DSN→SES end-to-end benchmark; native SES import code is landed only on PR #266 branch, with valid external SES still untested.
- Safe copper rip-up/re-route when moving components with branching traces, via endpoints and copper zones. The current pad endpoint reanchor algorithm intentionally refuses zoned boards rather than silently mutate protected GND fill.
- Electrical net planning, power-return/thermal/EMC, live KiCad IPC save-state semantics, exact Mega2560 mating/3D collision and differentiated signal/power routing.
- Zero unconnected with official ERC/DRC/parity and fabrication/assembly signoff on a current production PCB. Shield V19 original still has 85 unconnected; older CAD zone-fill acceptance does not imply V19 manufacturing readiness.

No RWMCP runtime deployment or release, no Ubuntu/SSD/Vision development.
