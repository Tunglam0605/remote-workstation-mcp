# RWMCP Word Phase E Acceptance

Status: PASS for v0.33.2 candidate
Date: 2026-09-23
Work Session: `65373f50-f553-4bf1-9bd0-dc9b163729ef`

## Scope

This acceptance closes the first Word milestone for the Office Capability Pack. It validates the complete mutation path rather than treating a successful ZIP write or Office Save as success.

## Accepted execution path

```text
inspect DOCX
  -> acquire office-file lease
  -> SHA-256 original
  -> backup + working copy
  -> typed OOXML patch
  -> structural re-inspection
  -> native Microsoft Word open
  -> native OMath verification
  -> PDF render
  -> acceptance assertions
  -> re-hash original for conflict detection
  -> same-volume replacement
  -> persisted transaction evidence
```

Transaction record, backup, working copy and render evidence live in owner-local RWMCP state, outside the authorized document workspace. Explicit rollback restores from the recorded backup and verifies the restored SHA-256 against the transaction's original identity.

## Real Windows acceptance evidence

The acceptance fixture contained one preserved Heading 1, one target paragraph, one embedded PNG image and no equation. The operation removed the target image, replaced the target text and inserted an editable OMML equation generated from Word-linear input.

Observed result:

- Microsoft Word version: `16.0`
- Word open: PASS
- page count: `1`
- native Word `OMaths.Count`: `1`
- PDF export: PASS
- PDF artifact size: `114365` bytes
- transaction state before rollback: `committed`
- post-edit headings: `1`
- post-edit images: `0`
- post-edit equations: `1`
- committed SHA-256 differs from the inspected original after the requested mutation
- rollback restored SHA-256: exact match with the original from the same acceptance run
- post-rollback images: `1`
- post-rollback equations: `0`
- RWMCP-owned `WINWORD` process cleanup: PASS in native helper acceptance

## Safety acceptance

Word mutation v1 is `.docx` only. Inspection may read Word OOXML macro/template variants, but mutation fails closed for macro-enabled formats and additionally blocks documents containing macros, ActiveX, embedded OLE objects or remote templates. External relationships are inspected but not followed. No arbitrary VBA, shell, Python, raw COM method, add-in or UI-automation surface is exposed.

Native Word validation runs in a bounded helper with alerts suppressed, Office automation security forced to disable macros, link-at-open disabled where supported, timeout handling and cleanup of only the RWMCP-owned process tree.

## Transaction acceptance

Automated tests verify:

- successful edit commits only after acceptance;
- backup remains byte-identical to the original;
- explicit rollback restores the exact original SHA-256;
- failed acceptance leaves the original byte-identical;
- stale expected SHA fails before mutation artifacts are created;
- rollback is restricted to the principal and Work Session that created the transaction;
- rollback refuses to overwrite a document modified after the transaction committed;
- no `.rwmcp-office` state directory is created inside the document workspace;
- semantic `stableId` from `word_inspect` can be passed directly into `word_edit`;
- bounded operation batches and invalid locators fail closed.

## Release gate

Before version finalization the repository gate passed:

- 
pm test`: 447 tests / 445 pass / 0 fail / 2 skip
- 
pm run typecheck`: PASS
- 
pm run build`: PASS
- 
pm run plugin:validate`: PASS
- `git diff --check`: PASS
- 
pm audit --omit=dev`: 0 vulnerabilities

The release-version gate was rerun for v0.33.2 after the Windows-only Office surface change and passed.

## Deferred work

Excel and PowerPoint remain intentionally deferred. MathType/UI automation remains an optional later fallback. OCR/vision extraction of arbitrary user images is a reasoning/input-preparation concern and is not embedded into RWMCP Office execution; once text/equation content is determined, `word_edit` performs the deterministic transactional replacement.
