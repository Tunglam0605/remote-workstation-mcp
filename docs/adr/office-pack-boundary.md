# ADR: Office Pack Boundary

Status: Accepted for Phase A
Date: 2026-09-23

## Context

RWMCP already has mature cross-cutting Core behavior and engineering-specific adapters/tools. Office automation has different domain objects and native dependencies. Putting Office under Engineering would couple unrelated domains. Treating Office as a Worker Provider would incorrectly mix deterministic execution with reasoning delegation.

## Decision

Office is a sibling capability pack:

```
RWMCP
├── Core
├── Engineering
└── Office
```

Core continues to own identity/authentication/authorization, principal, Work Session, Work Objective/Task DAG, scheduler, generic resource ownership/interlocks, audit, acceptance records where generic, data plane and worker registry.

Office owns Office-specific document identity, Office sessions, semantic locators, backend capabilities, document transaction semantics, render artifacts and Word/Excel/PowerPoint domain behavior.

Office is **not** an AI agent and **not** a Worker Provider.

## Reuse requirements

Office must reuse:

- `src/security/execution-context.ts` ownership;
- existing workspace/host-filesystem authorization;
- Work Session lifecycle;
- existing concurrency/interlock/resource patterns;
- audit;
- MCP registration and capability discovery.

It must not create a parallel authentication, scheduler or Work Session framework.

## Consequences

Positive:

- Engineering remains independent.
- Office dependencies can remain optional.
- Linux nodes can stay healthy without Microsoft Office.
- Future CAD/PLC/media packs can follow the same sibling-pack pattern.

Trade-off:

- Some engineering-named primitives may eventually prove generic and deserve extraction. Do not preemptively generalize them; extract only after Office creates a real second-use case.

## Rejected alternatives

- `engineering/office`.
- A universal "document/object/node" hierarchy across unrelated domains.
- Office as a reasoning-worker provider.
- A second Office-specific scheduler/auth system.
