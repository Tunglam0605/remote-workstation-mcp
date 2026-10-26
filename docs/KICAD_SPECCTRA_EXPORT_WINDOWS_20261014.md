# RWMCP Windows KiCad Agent: Native Specctra DSN Export Hand

2026-10-14 | Parent PR #264 | KiCad 10.0.6 on owner's Windows workstation | **Not released**

## Objective
Add a **real interoperability hand** so the Agent can prepare professionally routed PCB candidates for dedicated DSN/SES engines such as Freerouting. This stage implements **export only**, not external solver execution, SES import, zone-refill or manufacturing acceptance. External GPL-3.0 Freerouting source is not copied.

## Source-grounded integration
- KiCad 10 official `pcbnew` Python API offers `LoadBoard(...)`, `ExportSpecctraDSN(board, path)` and `ImportSpecctraSES(board, path)`: https://docs.kicad.org/doxygen-python-10.0/namespacepcbnew.html
- Freerouting's official KiCad integration explicitly recommends **Specctra DSN/SES** for production and identifies its JSON/API route as experimental: https://github.com/freerouting/freerouting/blob/master/integrations/KiCad/README.md
- Freerouting itself is GPL-3.0: https://github.com/freerouting/freerouting
- The owner's Windows workstation includes a working, bundled `C:\Users\Admin\AppData\Local\Programs\KiCad\10.0\bin\python.exe`, importing `pcbnew.Version()` = **10.0.6**. System Python 3.9 cannot load `pcbnew` and Java/Freerouting are not on PATH.

## New MCP tool: `kicad_specctra_export`

Work Session owner and workstation.write permission required; server-side audit enabled. Input:

```json
{
  "workspace": "projects",
  "projectPath": "Mega2560-Jack-Shield-V12/design/V12_2L/review/V19_FUNCTIONAL_COMPACT_WIP_20261014",
  "workSessionId": "AUTHENTIC_OWNER_WORK_SESSION_UUID",
  "board": "Mega2560_Robotics_Jack_Shield_V12_2L.kicad_pcb",
  "outputDir": "review/NEW_SPECCTRA_CANDIDATE_DIRECTORY",
  "expectedBoardSha256": "f7a5e1ba82b0c43b553c0bdac674b47735be46dffd88cc11b2f75c48d7cd1def"
}
```

Behavior:
1. Confirm explicit workspace authority, source file type/size (≤32MiB), exact original SHA-256, and path identity in the authorized project.
2. Reject any escaping output path, stale hash or already existing destination. No overwrite mode. Require KiCad 10+ packaged Python interpreter beside installed KiCad CLI; Windows-only.
3. Copy exact PCB bytes, copy project-local `fp-lib-table`, `sym-lib-table`, `*.pretty`, KiCad symbols/rules plus matching `.kicad_pro` into a fresh project-local output directory.
4. Execute the static, quoted-argument-free **native** `pcbnew.ExportSpecctraDSN(board, path)` function through the project `EngineeringCommandRunner`, no shell, under existing process policies and a **60 second bounded runtime**.
5. Confirm DSN is a non-empty regular file within 32MiB, compute SHA-256 of source/copy/DSN, re-read original source and refuse any unexpected source mutation, write `specctra-export-manifest.json`.
6. Report `solverRun:false`, `sessionImported:false`, `manufacturingApproved:false`. No claim to have routed any previously unconnected nets.

## Real Windows KiCad 10.0.6 acceptance

Source board unchanged (SHA-256):
`f7a5e1ba82b0c43b553c0bdac674b47735be46dffd88cc11b2f75c48d7cd1def`.

Project-local copy:
`review/RWMCP_SPECCTRA_EXPORT_V19_20261014_V1/`

DSN file:
`Mega2560_Robotics_Jack_Shield_V12_2L.dsn`.

Actual output DSN **144,417 bytes**.
SHA-256: `f5d65c2ccad13684c8028f9e2607e411306f6c77b9a34ac4deffde05e9641d56`.

The DSN contains a KiCad 10.0.6 host declaration, **two copper layers**, the actual board boundary and net names including `/GND`, `/A8` and `/D24`. It is suitable as input for a compatible Specctra autorouting engine, but no external solver has been tested on it in this milestone.

## Next engine milestones (must be separate gates)

1. Choose/install a bounded **licensed and versioned** Freerouting distribution or equivalent DSN solver; Windows Java runtime verification, integrity checks, controlled runtime/memory, no execution of arbitrary agent shell snippets.
2. Run solver on a copy, verify generated SES path/size/hash, and ensure source revision equality. Do not import a session from an unknown origin.
3. Use KiCad **native** `ImportSpecctraSES(board, ses)` on a new PCB copy; verify schema, preserved pads/nets/footprints, official KiCad CLI DRC/schematic parity **before and after**, and rollback on regression.
4. Explicitly handle copper zones/refills, geometrical/mechanical review, differential/high-speed and current/thermal constraints; never auto-fabricate merely because unconnected items reach 0.

Work tree only. This milestone is not a request to deploy or publish Windows RWMCP. Ubuntu/SSD/Vision remain unchanged.
