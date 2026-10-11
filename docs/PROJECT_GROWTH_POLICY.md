# RWMCP — Project Growth and Modular Architecture Policy

Updated: 2026-10-11. Scope: **framework** remote-workstation-mcp, not any particular device firmware or single PCB.

## Why size matters

A working tree contains node_modules, dist, screenshots, and offline UI asset libraries. Installed dependencies are not source-code bloat. Measure the Git source and distributable asset surface separately.

At the audit, there were 673 tracked files, about 2.77 MiB in src and about 23.04 MiB in assets. Large modules already requiring careful maintenance include:
- src/adapters/engineering/kicad.ts (approximately 133 KiB)
- src/adapters/engineering/workflow-engine.ts (approximately 114 KiB)
- src/setup/setup-server.ts (approximately 88 KiB)
- src/adapters/engineering/firmware.ts (approximately 72 KiB)

These four files are grandfathered with explicit caps; do not destructively split them without tests.

## Enforced controls

Run **npm run architecture:growth**, included in **npm run verify** and prepack. The check measures tracked and nonignored candidate files.

1. Folder file-count and byte budgets: src, tests, scripts, docs, assets, plugins, config.
2. A 65,000-byte per-file limit for new or normal JavaScript/TypeScript modules in src and scripts.
3. Exact, bounded exceptions for four already-large legacy modules. Avoid increasing them by casually adding new responsibilities.
4. A 3,000,000-byte per-asset limit, to prevent unreviewed graphics from bloating the shipped package.
5. Root archives (.tgz, .tar, .zip) are build outputs, not source files. Store externally.
6. The check is read-only. It never deletes files, refactors, changes budgets automatically, deploys to hosts, or approves production.

Config source: **config/project-growth-budget.json**. Budget increases must be reviewed with a reason and impact statement. Do not add an auto-rebaseline action.

## Module ownership

- **src/adapters/**: protocol, OS, KiCad and hardware primitives; typed transport and geometry. Do not register public tools here.
- **src/extensions/<domain>/**: domain workflows, capability composition, registration and policies. New KiCad features belong in focused modules instead of expanding kicad.ts indefinitely.
- **src/tools/**: public MCP schemas, validation, authorization and registration only.
- **src/engineering/** and **src/security/**: cross-domain validation and security, not project-specific pinout fixtures.
- **assets/**: stable UI media; optimize and deduplicate only after verifying render and fallback behavior.
- **docs/**: maintained guidance, not unbounded collections of test logs.
- **tests/**: deterministic capability acceptance tests, minimized fixtures.

The existing architecture:check enforces dependency direction and vendor-neutrality. This growth guard complements it; it is not a substitute for architectural review.

## Work Session disk footprint

Use **npm run worktree:footprint** (or append -- --json) to inspect session-owned Git worktree counts and cumulative disk usage. The diagnostic is read-only; it does not infer eligibility from age or a clean Git status alone. Always consult the authorized **work_session_lifecycle_preview** and use **work_session_worktree_cleanup** only when it reports the session is terminal and the worktree clean. Never run global Git prune or a force-delete on active, blocked or recovering sessions.

Each independent RWMCP Work Session may materialize a full source tree and node_modules. Keep their count bounded after terminal acceptance; runtime ownership, Git changes and rollback artifacts take precedence over space reclamation.

## Release workflow

Store build tarballs in an external artifacts directory, e.g. the Windows folder:

C:/Users/Admin/Documents/RemoteWorkspaces/_build_artifacts/remote-workstation-mcp

Recommended commands:

    npm run architecture:growth
    npm run verify
    npm pack --pack-destination "C:\Users\Admin\Documents\RemoteWorkspaces\_build_artifacts\remote-workstation-mcp"

CI/PR review must remain the release boundary. This branch does not replace the active RWMCP runtime, change MCP tool permissions or push any firmware to hardware.

## Refactor backlog

| Priority | Area | Safer migration |
|---|---|---|
| P1 | kicad.ts | Move independent validation, routing and rendering primitives into existing kicad-* modules, preserving public contracts and regression tests |
| P1 | workflow-engine.ts | Separate graph planning, execution and recovery checkpoints via typed interfaces |
| P2 | setup-server.ts | Separate static UI routes, state management and Windows/Linux specifics |
| P2 | Static seasonal graphics | Evaluate image compression and deduplication with visual regression checks; preserve UI fallback |

A smaller repository or ZIP is not sufficient evidence of sound engineering. Avoid refactors introducing circular dependencies, fragmented ownership, blind routing, permission bypass, or loss of rollback.
