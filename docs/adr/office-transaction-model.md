# ADR: Office Transaction Model

Status: Accepted for Phase A
Date: 2026-09-23

## Problem

Office files are compound packages. Partial writes, Office crashes, stale concurrent edits and incorrect backend assumptions can produce corrupt or semantically wrong documents. A successful Save is not sufficient acceptance evidence.

## Decision

Every mutating Office workflow uses a working-copy transaction:

```
OPEN
 -> INSPECT
 -> HASH ORIGINAL
 -> SNAPSHOT/BACKUP
 -> WORKING COPY
 -> PATCH
 -> APPLICATION OPEN TEST   (when required)
 -> RENDER                  (when required)
 -> VALIDATE
 -> ACCEPT
    PASS -> COMMIT
    FAIL -> ROLLBACK
```

## Identity and optimistic concurrency

Each transaction records:

- principal and Work Session;
- canonical original path and stable document identity;
- original SHA-256 plus useful stat metadata;
- backup path/hash;
- working-copy path/hash;
- backend selected per operation;
- validation and evidence artifacts;
- final outcome.

Immediately before commit, the original is hashed again. If it differs from the inspected version, the transaction becomes `CONFLICT` and does not overwrite the file.

## Resource ownership

Mutations acquire a stable Office resource key such as:

- `office-file:<canonical-path>`;
- domain-specific aliases only when required.

Read-only inspection may run concurrently if the backend is safe. Mutating access is exclusive.

## Commit

- All required acceptance assertions must pass.
- Prefer same-filesystem atomic replacement.
- Original remains untouched until commit.
- Keep a bounded backup under policy.

## Failure/recovery

- COM crash: clean up only RWMCP-owned application/process state.
- Timeout: mark failed and preserve bounded evidence/working copy.
- Corrupt working copy: original remains unchanged.
- Lost ownership/interlock: fail closed.
- Restart recovery reconciles non-terminal transactions; it never assumes an interrupted write committed.

## Rejected alternatives

- in-place fire-and-forget mutation;
- Save == PASS;
- force overwrite after an original-hash conflict.
