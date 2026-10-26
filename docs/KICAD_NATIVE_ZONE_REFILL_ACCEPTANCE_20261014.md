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


## Windows PR #279 follow-up — opt-in DRC-gated route plus zone refill (2026-10-26)

The typed `kicad_route_batch_apply` request now supports **`refillZones: true`**
(default: **false**). This is an explicit opt-in because persisted filled
copper changes beyond the requested route operations.

1. Verify the exact input-board SHA and run native KiCad DRC on the
   original, with `--refill-zones` in memory (no board save).
2. Stage the bounded segment/via batch with a full backup and run the same
   refilled DRC. Reject and restore the original if violations, unconnected
   nets, or schematic parity regress under the configured acceptance gates.
3. Only after in-memory DRC passes, use official KiCad CLI
   `pcb drc --refill-zones --save-board` on the staged changes.
4. Run **another official DRC on the saved PCB, without refill**, and apply
   the same gates. Any failure or exception restores the previous board
   content; accepted output reports the saved board SHA and DRC counts.

**Real-board evidence (isolated QA copy only):** On a SHA-verified duplicate
of Mega2560 V186, net `/A6` was routed with 11 segments + 1 via using the
optional 45° A* planner; estimated track length 33.2605 mm. With stale zone
fills, DRC identified four apparent copper clearance errors to the existing
`/GND` B.Cu pour and correctly rolled the original candidate back.
KiCad 10.0.6 `--refill-zones` recomputed the copper boundaries; native
`routeBatchApply(..., refillZones: true)` then **accepted** the route with
43 warnings before/after, unconnected **18 → 17**, parity 0 before/after,
and no new clearance violations. The saved QA board SHA is
`ab74a3fb8518eda2d9a6d30159b293e95cced90fd09856c5f1184b872695f688`.

The source V186 board SHA remains
`0a514cb3541b6c4b4ff925682f7b3762cd28c8950a05bc1605c979fb3cba9a9c`,
unchanged by these experiments. Unit tests exercise default fail-closed DRC,
successful refill/save plus durable recheck, and rollback when the saved-board
verification reports a new violation. Other V186 nets and silkscreen warnings
remain outstanding: this is **one-net engineering acceptance, not PCB
manufacturing approval**. Do not silently enable refill for unrelated tools,
alter the owner's original board, or publish Gerbers before full acceptance.
