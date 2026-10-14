# RWMCP Windows KiCad Agent — Safe Specctra SES Import

**Date:** 2026-10-14 | **Parent:** PR #265 | **KiCad:** 10.0.6 | **State:** development / not released.

## Objective

Complete the **native interchange path** for a future advanced autorouter: KiCad original PCB → native `ExportSpecctraDSN` (PR #265) → an explicitly acquired external `.ses` → native `ImportSpecctraSES` on a separate copy → **independent KiCad CLI DRC/parity** → review-only candidate.

This PR does **not** bundle, install or execute Freerouting, does not invent a routing result, does not provide zone-fill automation and does not change the original PCB. Freerouting's own software is GPL-3.0; no upstream program code is copied.

## Tool: `kicad_specctra_import`

Mandatory Work Session and scoped `workstation.write` permission. Example request:

```json
{
  "workspace": "projects",
  "projectPath": "Mega2560-Jack-Shield-V12/design/V12_2L/review/V19_FUNCTIONAL_COMPACT_WIP_20261014",
  "workSessionId": "OWNED_WORK_SESSION_UUID",
  "board": "Mega2560_Robotics_Jack_Shield_V12_2L.kicad_pcb",
  "schematic": "Mega2560_Robotics_Jack_Shield_V12_2L.kicad_sch",
  "ses": "review/DSN_EXPORT/sample.ses",
  "exportManifest": "review/DSN_EXPORT/specctra-export-manifest.json",
  "outputDir": "review/NEW_SES_IMPORT_CANDIDATE",
  "expectedBoardSha256": "f7a5e1ba82b0c43b553c0bdac674b47735be46dffd88cc11b2f75c48d7cd1def",
  "expectedSessionSha256": "REPLACE_WITH_ACTUAL_LOWERCASE_SHA256_OF_SES"
}
```

### Safety requirements

1. Exact original source revision SHA and independent SES SHA required; source and session must be regular bounded files under the authorized project. Output directory must be new, project relative and cannot follow a path outside the project.
2. The original project-local `specctra-export-manifest.json` must match the same original PCB SHA, name and original copied board. Recompute and compare the DSN SHA, the source copy SHA, and require both in the same export folder. Reject manifest or DSN tampering.
3. Only the bundled KiCad 10+ Windows Python/pcbnew interpreter beside KiCad CLI is eligible. The native import uses a static Python code path in a **no-shell**, 60s process with RWMCP engineering policy.
4. Perform native `pcbnew.ImportSpecctraSES(BOARD, file)` on the **staged PCB copy**, not the original. Compute before/after native fingerprint of all footprint identities/references/positions/rotations, pad UUID/net/coordinates/layers, net names, Edge.Cuts drawings and zones. Any change to these protected design elements refuses the candidate.
5. Preserve all already-existing power and return copper on protected supply, ground, regulator and eFuse nets. The importer may add routed copper but it must not silently remove a protected original track. Power/thermal/EMI engineering acceptance is still separate.
6. Save the candidate to an isolated `.kicad_pcb`; reopen natively to confirm design fingerprint. Run official KiCad CLI DRC and optional schematic parity using the matching project/schematic and copied project-local libraries.
7. Accept as **review-only** only when `unconnected` falls **strictly**, active geometry violations/errors do not increase and schematic parity does not regress. Otherwise publish `candidate-rejected` with the exact DRC reasons. Never claim manufacturing approval.
8. Re-read and compare original PCB SHA before returning, write candidate/session/provenance SHA and exact baseline/after DRC counts in `specctra-ses-import-manifest.json`. No original PCB modification or implicit save.

## Actual acceptance evidence

- Windows KiCad 10.0.6 bundled Python successfully imported `pcbnew` and exposed expected `NETCODES_MAP`, per-pad UUID/layer, zone and board geometry APIs.
- **Real Shield V19 failure-path test:** a deliberately malformed `(session ...)` on an isolated test path was fed to native `pcbnew.ImportSpecctraSES`. KiCad rejected it, RWMCP surfaced `Native KiCad SES import failed closed`, original V19 PCB SHA remained `f7a5e1ba82b0c43b553c0bdac674b47735be46dffd88cc11b2f75c48d7cd1def`.
- Native negative-path acceptance was repeated after enabling protected power-track comparison; same safe result.
- Unit tests: stale PCB/SES SHA, manifest/DSN tampering, unsafe folder paths and overwrite; simulated positive and no-improvement gate prove acceptance/rejection manifest logic. **The positive tests use a fake runner and fake DRC response**: they do **not** demonstrate successful import of a valid Freerouting-generated session.
- **Pending:** actual portable Java/Freerouting setup, true DSN autoroute of a test board and successful native SES import + official KiCad DRC improvement. Do not claim that this entire pipeline is operational without that acceptance.

## Remaining larger KiCad automation project

P0: Verified external solver installation and full DSN → SES → DRC with rollback, native zone refill with saved-board validation.

P1: Intelligent net/branch rip-up and re-routing; 3D component/connector mating; professional functional-block schematic and physical layout (UART, SPI, PS2, I2C, PWM, L298, stepper, power); power routing and return-loop analysis.

P2: Full two-layer PCB implementation and **zero** unconnected / ERC / DRC / parity / manufacturing checks, followed by explicit human acceptance.

**Production RWMCP is still `v0.70.0-dev.10` and Windows only. Do not release/merge these draft stacks automatically. Ubuntu/SSD/Vision development remains frozen.**
