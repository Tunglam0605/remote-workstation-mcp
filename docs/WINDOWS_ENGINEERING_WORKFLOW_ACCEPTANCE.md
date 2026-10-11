# Windows Engineering Workflow: KiCad Acceptance / Work Session Handoff

Effective 2026-10-11. Scope: Windows only. Ubuntu remains legacy/frozen.

## Purpose

KiCad validation (ERC/DRC), electrical acceptance, physical sign-off and Gerber export are different gates. No worker or workflow may claim a board is manufacturable merely because ERC/DRC reports zero violations.

## Reusable design chain

1. Owner intent and electrical constraints: intended signals/voltages, target footprint and stacking, driver power ownership, connector mating orientation, physical enclosure, harness clearances and test goals.
2. Work Session/project binding: select the canonical matching same-basename schematic, project and PCB set; never join files from unrelated revisions.
3. Schematic/footprint design: pin ownership, levels, power budgets, optional interface/level shifting, footprints, netlist and ERC.
4. PCB placement and routing: physical footprint courtyard, edge/cable clearance, bounded routing and real DRC with all unconnected and schematic-parity findings.
5. Run engineering_workflow_plan and engineering_workflow_run with workflow ID kicad.design_acceptance. It performs read-only KiCad designReview and official ERC/DRC, validates source SHA-256, PCB/schematic consistency, actual routed copper, model declarations, and bounded numeric evidence.
6. Independently obtain owner approval for physical mating, connector polarity, 3D placement/STEP, mounting, power load, enclosure, thermal, EMI, manufacturing rules and prototype plan.
7. Only after the preceding gates and explicit intent, consider kicad.fabrication_export. A successful export never certifies assembly safety or physical fit.
8. Bench-verify the manufactured prototype.

## Acceptance statuses

- succeeded + ELECTRICAL_PASS_PHYSICAL_HOLD: electrical checks succeeded. manufacturingAccepted=false always. Physical-review holds remain recorded.
- blocked + ELECTRICAL_BLOCKED: ERC/DRC error/warning, unconnected copper, mismatched schematic/PCB, duplicate/missing footprint assignment or absent routed copper.
- failed: provider failure or missing/untrustworthy SHA-256, official ERC/DRC report, or incomplete/invalid review evidence. Never substitute guessed zero counts.
- ignored KiCad DRC check types and missing 3D declarations are explicitly shown as physical/manufacturing review holds. 3D declaration does not itself prove assembly fit.
- No new public MCP tool is required; the workflow uses the existing Engineering Workflow Engine and KiCad adapter.

## Work Session / Codex / Antigravity operating rules

Workflow authority: owner instructions → authenticated Work Session → durable task graph and attempt → assigned Git worktree → optional worker execution → deterministic technical evidence → QualityObservation → owner approval.

- ChatGPT may execute typed RWMCP tools directly; Codex/Antigravity are optional workers, not mandatory middleware.
- Owner execution policy and Work Session scopes define target eligibility; a session may narrow but never widen permission/target sets.
- No two workers should mutate the same PCB output concurrently. Use isolated clean Git worktrees and single accountable Work Session task attempts, then review before merge.
- A worker reporting succeeded is not the same as approved electrical or manufacturing acceptance. The bound workflow may still block the parent task if native checks fail.
- Codex-to-Antigravity fallback follows the existing execution-policy limits. Do not cross-fallback when a worktree is dirty or resource ownership is uncertain.
- Use durable TaskAttempt/workflow timeline for completion and recovery, not transient worker stdout or chat wording. Do not repeat cloud/hardware mutations after a reconnect without transaction reconciliation.
- Existing lifecycle preview is authoritative for safe closure. Do not bulk-delete recovering/blocked/idle Work Sessions or dirty worktrees.
- Report readiness (provider installed, active IPC, official native acceptance) separately, and preserve source evidence hashes in checkpoints instead of copying complete design files into state.

## Test/release gates

Typecheck, source boundaries, growth budget, security policy, unit tests, Windows CI, Windows packed-runtime smoke and owner-reviewed runtime update/rollback. Include positive, blocked, missing evidence and no source mutation tests.

Native KiCad 10 Mega V11 reference: 69 routed nets, 452 copper segments, 29 vias, ERC=0, DRC=0, unconnected=0, schematic parity=0; 5 ignored DRC check types and 1 footprint with no 3D declaration. It passes electrical acceptance but never physical/manufacturing signoff.

Mega V12 JST Jack Shield has a functional connector plan but does NOT yet have an accepted schematic and routed PCB. Do not mark V12 accepted.
