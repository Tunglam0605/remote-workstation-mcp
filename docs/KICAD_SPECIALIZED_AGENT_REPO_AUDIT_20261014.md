# Windows RWMCP KiCad Agent — Specialist repository audit and route recovery
Date: 2026-10-14 | Baseline: `0e77bc6`, PR #260 | KiCad 10.0.6 | Target Windows only

## Selection criteria

The review considers project architecture and demonstrable source/documentation, not GitHub star count. Priority: production-like KiCad10 interoperability, schematic-board authority, constraint-aware placement, safe iterative routing, independent DRC/rollback, mechanical-first review, and manufacturing gates. A repository's README claims do **not** constitute Windows acceptance for RWMCP.

| Upstream repo / license | What was inspected | Valuable capability | RWMCP current gap / action |
|---|---|---|---|
| [nevenfo/kicad-agentic-mcp](https://github.com/nevenfo/kicad-agentic-mcp), AGPL-3.0 | README, transaction control, exact revisions, Plan IR documentation | Intent becomes typed reference-checked plan; revision/idempotency ledger; semantic diff and stable DRC evidence | Retain our SHA/WorkSession framework; future: persistent revision-linked task and issue ledger. **Do not copy AGPL source.** |
| [mixelpixx/Konnect](https://github.com/mixelpixx/Konnect), AGPL-3.0 | `docs/DRC_SYNCHRONIZATION.md`, README | Live KiCad10 IPC/save/read-back DRC synchronization with precise uncertainty/refusal modes | Later: explicit `live != saved` barrier and zone-refill verification; keep exact-target binding. **Do not copy AGPL source.** |
| [biosshot/kicad-copilot](https://github.com/biosshot/kicad-copilot), MIT | `docs/pcb-layout/instructions.md` and placement MCP workflow | Mechanical-first preview, functional blocks, independent routing DSL, checkpoints | Next: explicit 3D mechanical gate for Mega USB, ICSP, JST plug/cable access before any placement. Original code not copied. |
| [palginpav/tracewise](https://github.com/palginpav/tracewise), Apache-2.0 | README and repository description | Datasheet-grounded schematic review, routing constraints, DSN compatibility diagnostics and bisect | **Implemented concept here:** bounded DRC-guided group isolation on copied PCB after a rejected batch. This is our own TypeScript algorithm, not upstream source code. |
| [oaslananka/kicad-mcp-pro](https://github.com/oaslananka/kicad-mcp-pro), MIT | `docs/agents/progressive-disclosure.md` | Small role-based tool profile, review/build/release separation and human-only manufacturing | Next: task-specific tool surface to avoid dumping hundreds of tools into an agent's planning context; RWMCP's execution policy remains authoritative. |
| [blwfish/kicad-mcp](https://github.com/blwfish/kicad-mcp), MIT | README, AGENT-INSTALL, `pcb_autoroute.py` indexed source | Freerouting integration, bounded asynchronous route jobs, agent installation guide | Next: isolated optional DSN/SES solver adapter; Java availability, actual KiCad CLI compatibility and DRC must be verified on Windows. |
| [seunghyukchoe/copper-mcp](https://github.com/seunghyukchoe/copper-mcp), Apache-2.0 | README, safety/immutable-candidate contract | Revision-bound immutable candidate, explicit operator apply; accurate geometry | Reinforce SHA-bound preview, no source mutation and independently verified selected copy. |
| [circuit-synth/circuit-synth](https://github.com/circuit-synth/circuit-synth), MIT | README feature catalog, checked LICENSE | Python-hierarchical, reusable circuit/module patterns, symbol/footprint verification, FMEA | Later: datasheet-backed company-approved circuits for LM2596/TPS26600/STM32 only, never trust a template without BOM/pinout and electrical verification. |
| [glovepost/atoplace](https://github.com/glovepost/atoplace), MIT | `atoplace/placement/legalizer.py`, README | Manhattan grid, component row alignment, overlap avoidance with priorities | Existing constrained placement only checks bounds/courtyards; next: robust mechanical/3D and functional-block legalization without blindly moving Mega anchors. |
| [ProductOfAmerica/mcp-server-kicad](https://github.com/ProductOfAmerica/mcp-server-kicad), MIT | README, KiCad 10 file editing and routing snippets | Typed KiCad edits, schematic/PCB sync, autorouting bridge | Improve project-graph and schematic-to-board synchronization, preserving exact programmatic source authority. |

**Method/limitations:** Read accessible GitHub files directly using connected GitHub repository access, web-verified current README summaries and license files. No repositories were installed or executed in RWMCP. Features may be beta/experimental and should be validated before any integration. No third-party code was copied into the project. Freerouting is GPL-3.0; AGPL tools require separate licensing review before any code reuse or redistributable integration.

## New feature — deterministic DRC-failure route isolation

New `src/adapters/engineering/kicad-route-recovery.ts` and an **opt-in** extension of `kicad_autoexperiment_run`:
```json
{
  "iterations": {
    "maxRounds": 4,
    "maxNetsPerRound": 4,
    "autoSelectUnconnected": true,
    "includePowerNets": false,
    "recoverRejectedBatches": true,
    "maxRecoveryChecks": 6
  }
}
```

1. Original automatic routing group is committed **only** when KiCad DRC passes, unconnected decreases strictly and parity/errors/violations do not regress.
2. If the batch is rejected and at least two nets produced routes, split the group into deterministic halves. Try each subset with the existing KiCad-aware A* router.
3. Each isolated trial is written to a unique project-local copy (`round-NN/isolate-NN`) with original project `.kicad_pro`, `.kicad_sch`, symbol/footprint libraries and native KiCad DRC.
4. Trial results are accepted independently, never carry an unverified or rejected route to the next trial. Recursively split rejected groups within strict `maxRecoveryChecks` and planning budgets (max 8 DRC validations).
5. Preserve the previously accepted source when a test fails; accumulate only validated copper and actual added track/via metrics.
6. For recovery-enabled experiments, copy the accepted **exact bytes** to `scenario/accepted/board.kicad_pcb`, copy KiCad local libraries, rerun official KiCad DRC and compare verified counts **before** publishing its path/SHA in the manifest. If the final check disagrees, reject the report and leave the source PCB untouched.
7. Mark critical supply/switch/return nets excluded from automatic target discovery; never infer that a valid route is thermally/EMC/fabrication safe.
8. Leave public defaults unchanged: `recoverRejectedBatches: false` unless explicitly requested. Release/runtime and Ubuntu remain unchanged.

## Regression & Windows acceptance evidence

- New synthetic KiCad fixture: two separate nets, aggregate route fails DRC due to one net; binary isolation accepts only the good net. Checks prove rejected copper is absent, the recovery budget is enforced, and the source text is unchanged.
- Adapter-level test: the selected accepted file is independently revalidated, its SHA matches the manifest, and any final-board DRC mismatch refuses publication.
- Real KiCad 10.0.6 V19 test on a **new isolated copy**, `review/RWMCP_AUTORECOVERY_20261014_V1/`: original board SHA remained **`f7a5e1ba82b0c43b553c0bdac674b47735be46dffd88cc11b2f75c48d7cd1def`**; DRC unconnected **85 -> 82 -> 79 -> 76 -> 75** over four accepted rounds, with **0 new geometric violations, 0 parity regression** and **82 typed routing operations** accepted. Final selected candidate SHA: **`d3453fa580822839446b74d1191dccfc8913da83e6884c81898c64d59176abf6`**. Candidate folder ends in `routing-only/accepted/`.
- **Important:** Every V19 batch was accepted directly, so the new bisection code was **not exercised by a real failing V19 batch**; only isolated and adapter-level tests establish bisection recovery so far. V19 remains **75 unconnected**, not fabrication ready.

## Prioritized production work

P0 — Finish the physical design intent workflow: board outline/rounded corner geometry, Mega mating coordinates/headers orientation, USB/DC jack/ICSP clearance, JST cable corridors, and user-approved mechanical preview. Do not propose moves until these are explicitly grounded.

P1 — Functional-block zoning and validated schematic/pad-map contract: 12 UART connectors as one group, stepper one group, PS2 one group, L298 one group, PWM and I/O groups. Disallow silent pin assignment changes; maintain two-layer constraint.

P2 — Recovery enhancements for partial multi-pad networks and rip-up/re-route after footprints move, with native zone refill; only on copies and DRC-gated.

P3 — Optional isolated Freerouting or alternate engine DSN/SES bridge, Windows Java readiness, deterministic CPU/time/memory bounds, license clearance and DRC-independent acceptance.

P4 — Datasheet-backed buck/eFuse rules for input reverse-polarity, TPS26600 RTN, switching hot loop, ripple/thermal/EMI, sensor/logic return paths. Pair electrical review with power integrity checks.

P5 — Complete **0 unconnected, ERC/DRC/parity clean**, compare 3D assembly and manufacturer fabrication rules, then optional Gerbers with explicit human release acceptance.

Status: Source branch only. Do not merge/deploy until CI and review pass. Original V19 file remains unmodified.
