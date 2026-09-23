# RWMCP Office Pack Reference Study

Status: research checkpoint complete; architecture evidence sufficient to start Phase A.
Date: 2026-09-23
Work Session: `65373f50-f553-4bf1-9bd0-dc9b163729ef`
Source baseline: `f7576cc2b8783860991c34453a32a7c3c7509030` (`v0.32.4` package/tag)
Production baseline: `v0.32.3` on all three direct nodes

## 1. Current RWMCP baseline

Verified from the canonical repository and live runtimes:

- `main == origin/main == f7576cc2b8783860991c34453a32a7c3c7509030`; canonical worktree is clean.
- `package.json` version is `0.32.4`; local tag `v0.32.4` exists.
- The production release channel still reports `v0.32.3` as latest; Windows, Ubuntu Personal and Ubuntu Vision are all running `0.32.3`, healthy, authenticated and direct-control-path verified.
- Action Schema = 11; Engineering API = 5.
- The Windows connector currently exposes 141 RWMCP MCP tools.
- Codex and Antigravity worker providers are available and dispatch-capable.
- Existing cross-cutting infrastructure already includes principal/policy, Work Session, Work Objective/Task DAG, scheduler awareness, task attempts, resource ownership/interlocks, audit and data plane.
- Existing engineering-specific code already has domain boundaries under `src/engineering`, `src/adapters/engineering` and `src/tools/engineering-tools.ts`.
- Office research runs in an isolated clean worktree. Parallel worktrees were detected; the dirty artwork worktree was not touched.

Regression baseline before Office implementation:

- `npm test`: 426 tests / 424 pass / 0 fail / 2 skip.
- `npm run typecheck`: PASS.
- `npm run build`: PASS.
- `npm run plugin:validate`: PASS.
- CI workflows present: `.github/workflows/ci.yml`, `release-request.yml`, `release.yml`.

Existing RWMCP extension points to reuse, not duplicate:

- `src/context.ts`: composition root and service lifetime.
- `src/capabilities.ts`: capability discovery.
- `src/concurrency-policy.ts`: bounded concurrency classification.
- `src/security/execution-context.ts`: principal + Work Session resource ownership.
- `src/node-interlock.ts`: durable interlock semantics.
- `src/work-session.ts`, `src/work-session-lifecycle.ts`: restart-aware state/lifecycle.
- `src/security/audit.ts`: audit path.
- `src/server.ts` and `src/tools/*`: typed MCP registration.

## 2. Microsoft / OpenXML findings

### dotnet/Open-XML-SDK

**Purpose.** Microsoft's canonical low-level .NET SDK for Office Open XML packages.

**Architecture.** OPC package/part/relationship model plus generated strongly typed WordprocessingML, SpreadsheetML and PresentationML elements. `WordprocessingDocument`, `SpreadsheetDocument` and `PresentationDocument` are package specializations. Validation is distinct from mutation.

**Source inspected.**
- `src/`
- `data/parts/WordprocessingDocument.json`
- `data/parts/SpreadsheetDocument.json`
- `data/parts/PresentationDocument.json`
- `docs/Features.md`
- `docs/Diagnostics.md`
- `CHANGELOG.md`

Inspected checkout: `431ab05`, 2026-08-18.

**Strengths.**
- Authoritative reference for OPC, content types, relationship graphs and typed markup.
- Good package/part integrity and schema validation model.
- Unknown/advanced parts can be preserved without flattening everything into a generic object.

**Weaknesses.**
- Deliberately low level; not a productivity abstraction.
- Does not provide Word layout, Excel calculation or PowerPoint rendering semantics.

**Dependencies / license / activity.** .NET/NuGet; MIT; actively maintained in the inspected checkout.

**Patterns reusable.**
- Relationship-driven discovery, never ZIP-path guessing.
- Structural package validation separated from application validation.
- Typed domain markup rather than generic XML mutation.
- Preserve unknown parts/content types/relationships when not intentionally modified.

**Patterns not suitable.**
- Exposing raw `OpenXmlElement` mutation as an MCP operation.
- Reimplementing OPC or ISO 29500 from scratch inside RWMCP.

### OfficeDev/Office-Add-in-samples, OfficeDev/office-js-snippets, OfficeDev/office-js

These Microsoft sources were used primarily as **semantic/API design references**, not as the intended RWMCP backend.

**Findings.**
- Word semantics center on Document, Range, Paragraph, Table, ContentControl, image and OOXML.
- Excel semantics center on Workbook -> Worksheet -> Range, with values/text/formulas treated as distinct concepts.
- PowerPoint semantics center on Presentation -> Slide -> Shape/Placeholder, with shape identity useful for targeting.
- Office.js explicitly synchronizes loaded state through context synchronization; this reinforces that live-application state is not identical to static file state.
- Small snippets are intentionally operation-scoped and typed.

**Reusable patterns.**
- Domain vocabulary and operation boundaries.
- Explicit document/workbook/presentation context.
- Stable IDs/anchors when the host exposes them.
- Small typed operations composed into bounded batches.

**Rejected.**
- Office.js as RWMCP's primary backend. It would impose add-in/browser-host deployment and would not satisfy the required local headless package path.

## 3. COM automation findings

### mhammond/pywin32

**Purpose.** Python access to Windows APIs and COM automation.

**Source inspected.**
- `com/win32com/client/dynamic.py`
- `com/win32com/client/__init__.py`
- `com/win32com/src/PythonCOM.cpp`
- COM demos/tests

Checkout: `9f88183`, 2026-09-08.

**Findings.**
- `Dispatch` can bind/create Office automation objects.
- `DispatchEx` is useful when isolation from an existing user's Office process is required.
- Worker threads must own COM apartment initialization/uninitialization correctly.
- COM references and close/quit ordering directly affect whether WINWORD/EXCEL/POWERPNT processes become zombies.

**Strengths.**
- Gives access to the real Word/Excel/PowerPoint application object model, calculation and rendering engines.

**Weaknesses.**
- Windows-only; apartment/thread sensitive; HRESULT/automation failures require normalization.
- Poor lifecycle discipline can leak Office processes or attach to the wrong application instance.

**Dependencies / license / activity.** Windows + pywin32; project-specific permissive licensing; active at inspected checkout.

**RWMCP implications.**
- Native Office work needs an explicit COM worker/lane with bounded lifecycle.
- Mutating deterministic workflows should create an isolated application instance by default.
- Attaching to an existing user Office process must be a separate explicitly targeted capability.
- Raw COM dispatch/method invocation must never cross the MCP tool boundary.

## 4. Existing Office MCP findings

### mhackermsft/OfficeMCP

**Purpose.** Unified MCP surface for Word, Excel, PowerPoint and PDF.

**Architecture.**
- Format-specific services registered through DI.
- Consolidated `office_*` tools plus format-specific tools.
- Three disclosure tiers: core/common/advanced.
- Word/Excel/PowerPoint services use DocumentFormat.OpenXml.
- Encrypted/protected document handling is separated.

**Exact files inspected.**
- `OfficeMCP/Program.cs`
- `OfficeMCP/Tools/OfficeDocumentToolsConsolidated.cs`
- `OfficeMCP/Services/WordDocumentService.cs`
- `OfficeMCP/Services/ExcelDocumentService.cs`
- `OfficeMCP/Services/PowerPointDocumentService.cs`
- `OfficeMCP/OfficeMCP.csproj`

Checkout: `6ea9bb7`, 2026-03-04.

**Strengths.**
- Strong reference for progressive disclosure and compressed tool surface.
- Demonstrates common Office metadata/read operations plus domain-specific advanced operations.

**Weaknesses.**
- OpenXML-only behavior cannot prove native Word rendering, Excel recalculation or PowerPoint layout fidelity.
- Very large format services risk becoming monolithic.

**License.** No root LICENSE file was observed in the inspected checkout, so source must not be copied without independent license verification.

**Adopt.** Progressive disclosure, shared metadata/read concepts, separate protected/encrypted handling.

**Reject.** Large per-format god services; "OpenXML save succeeded" as acceptance.

### dosev-ai/mcp-office

**Purpose.** Local-first governed Word/Excel/PowerPoint/Outlook MCP packages.

**Architecture.**
- Separate packages: `wordmcp`, `excelmcp`, `pptmcp`, `shared`.
- Optional COM path plus high-level OOXML libraries.
- Excel COM concerns are decomposed into gates, session, export, recalculation, pivot and VBA modules.

**Exact files inspected.**
- `wordmcp/src/wordmcp/server.py`
- `excelmcp/src/excelmcp/_com.py`
- `excelmcp/src/excelmcp/_com_gates.py`
- `excelmcp/src/excelmcp/server_com_session.py`
- `excelmcp/src/excelmcp/server_com_recalc.py`
- `excelmcp/src/excelmcp/server_com_vba.py`
- root `pyproject.toml`

Checkout: `d8f84dd`, 2026-09-23; MIT.

**Strengths.**
- Optional COM is fail-closed.
- Live session bridge is distinct from static file editing.
- Paths and risky features are gated; macro execution has a separate explicit gate.
- COM infrastructure deliberately avoids module-level COM globals.

**Weaknesses.**
- Standalone environment-variable authorization/gating should not be duplicated inside RWMCP.

**Adopt.**
- Explicit COM feature detection.
- Static-file vs live-application separation.
- Macro-disabled-by-default philosophy.
- Capability-specific gates.

**Reject.**
- Parallel auth/session/allowlist infrastructure; RWMCP already owns those concerns.
- Running separate MCP servers per Office application inside RWMCP.

## 5. Word findings

### python-openxml/python-docx

**Purpose.** High-level DOCX read/write API.

**Exact files inspected.**
- `src/docx/document.py`
- `src/docx/blkcntnr.py`
- `src/docx/package.py`
- `src/docx/parts/*`
- `src/docx/oxml/*`

Checkout: `e454546`, 2025-06-16; MIT.

**Strengths.**
- Productive abstractions for Paragraph, Run, Style, Table, Section, comments and inline shapes.
- Keeps access to package/part/XML layers for unsupported constructs.

**Weaknesses.**
- Not the complete Word object model.
- Tracked changes/revisions, advanced equations and native layout behavior require raw OOXML and/or Word COM.
- Paragraph ordinal/index is not a durable locator.

**Use in RWMCP.** A possible helper for supported headless operations, never the sole source of truth.

### juanocampo400/word-mcp

**Purpose.** Word editing with live COM and tracked-change workflows.

**Exact files inspected.**
- `src/word_mcp/com_pool.py`
- `src/word_mcp/document_manager.py`
- `src/word_mcp/server.py`
- `src/word_mcp/tools/*`

Checkout: `16ab829`, 2026-02-18; MIT.

**Findings.**
- Uses `DispatchEx("Word.Application")` for isolated native instances.
- Explicit close/save/pool shutdown.
- `TrackRevisions` is a native Word concern.
- Saving is explicit rather than incidental.

**Adopt.**
- Isolated native Word lifecycle.
- Native backend for revisions, OMath verification and rendering.

**Reject.**
- Paragraph index as the primary durable edit locator.

### Word equations / OMML

Microsoft Office math references establish that modern Office accepts MathML/LaTeX representations and stores native math using Office Math Markup Language (OMML).

**Decision.**
- Equation is a first-class Word domain capability.
- LaTeX/MathML/Word-linear are interchange inputs; normalized conversion must be explicit.
- Word persistence/acceptance terminates in OMML/OMath.
- Acceptance must reopen with Word and prove an editable OMath object exists.
- Image-only "equations" fail acceptance.
- MathType is an optional later UI/add-in adapter, never a required Office Pack dependency.

## 6. Excel findings

### xlwings/xlwings

**Purpose.** High-level Excel automation API.

**Exact files inspected.**
- `xlwings/main.py`
- `xlwings/_xlwindows.py`

Checkout: `3dc83bb`, 2026-09-23.

**Findings.**
- Clear App -> Book -> Sheet -> Range model.
- Graceful `quit()` and forceful `kill()` are distinct.
- Native `calculate()` is application behavior.
- Windows backend wraps COM and retry behavior.

**Strengths.** Excellent COM lifecycle/domain-facade reference.

**Weaknesses.** RWMCP does not need the whole runtime; xlwings PRO has separate licensing.

**License.** Open-source core is BSD; PRO functionality is separately licensed.

### mbeps/excel-mcp

**Purpose.** Broad Excel MCP operations for workbook/sheet/range/formula/format/chart/analysis.

**Exact files inspected.**
- `src/mcp_server/routes/formulas.py`
- `src/mcp_server/tools/formulas.py`
- `src/mcp_server/utils/excel_helpers.py`
- `src/mcp_server/utils/expression_validator.py`

Checkout: `3439a85`, 2026-09-16; MIT.

**Findings.**
- Typed formula actions include set/batch/fill patterns.
- File scope and extension checks are explicit.
- Custom mathematical expressions are AST constrained.
- Formula and range operations are separate concerns.

**Adopt.**
- Typed batches.
- Formula inspection/validation separate from mutation.
- Bounded/chunked range handling.
- No arbitrary Python or shell for transformations.

**Reject.**
- Mirroring its full tool count into RWMCP.

### openpyxl

**Purpose.** Python XLSX/XLSM reader/writer.

**Upstream note.** The canonical current source is hosted on Heptapod/Mercurial; a random GitHub mirror must not be treated as upstream authority.

**Relevant implementation areas.**
- workbook model
- worksheet/range/cell model
- formula structures
- package/relationship handling
- styles/charts

**Strengths.** Strong deterministic headless XLSX manipulation.

**Limitations.**
- Not the Excel calculation engine.
- Formula storage/preservation is not proof of evaluated results.
- External links/caches/security-sensitive XML require care.

**Decision.** Suitable candidate for later headless Excel operations; native Excel COM remains required for calculation acceptance.

### jmcnamara/XlsxWriter

Checkout: `5d4606d`, 2026-08-05; BSD-2-Clause.

**Purpose/strength.** High-quality XLSX generation with formatting, charts, validation and memory-conscious write paths.

**Weakness.** Generation-focused, not a live editing engine and not a formula calculation engine.

**Use.** Reference for generation/memory patterns only.

## 7. PowerPoint findings

### scanny/python-pptx

**Exact areas inspected.**
- `src/pptx`
- `docs/api/shapes.rst`
- `docs/api/slides.rst`
- placeholder and shape-tree analysis docs

Checkout: `278b47b`, 2024-08-07; MIT.

**Findings.**
- Slide content is fundamentally a shape tree.
- Placeholder is a shape specialization coupled to layout/master semantics.
- Headless structure can be manipulated productively without native PowerPoint.

**Limitations.** It cannot substitute for PowerPoint's native layout/render fidelity.

### Yans14/powerpoint_mcp

**Purpose.** PowerPoint MCP with separate COM and OOXML engines.

**Exact files inspected.**
- `python/engine_selector.py`
- `python/engines/base.py`
- `python/engines/com_engine.py`
- `python/engines/ooxml_engine.py`
- `python/com_worker.py`
- `python/tool_catalog.py`
- `src/server.ts`

Checkout: `9e635e7`, 2026-03-09.

**Findings.**
- COM is chosen on Windows when available, with OOXML fallback.
- Both engines maintain explicit presentation sessions.
- COM calls are isolated behind a worker.
- Tool catalog/validation is separated from engines.
- Slide snapshots are first-class evidence artifacts.

**Strengths.** Closest source reference to the required dual-engine architecture.

**Weaknesses.**
- RWMCP should select backend per required capability/operation rather than relying on one global preferred engine.
- RWMCP already owns policy/session/resources; those parts must not be duplicated.
- No root LICENSE was observed; do not copy implementation without license verification.

**Adopt.**
- Explicit engine interface.
- Session-scoped working state.
- Snapshot/render artifacts.

## 8. Patterns worth adopting

1. Office as a sibling capability pack to Engineering.
2. Capability-aware native COM + OOXML/headless backends.
3. UI automation only as explicit later fallback.
4. Backend selection per operation, with no silent semantic downgrade.
5. Office sessions bound to existing principal + Work Session.
6. Explicit COM apartment/worker ownership and process lifecycle.
7. Stable document identity + SHA-256 optimistic concurrency.
8. Working-copy transactions; original stays untouched until acceptance.
9. Separate package validation, application-open validation and visual/render evidence.
10. Typed bounded batch operations and progressive disclosure.
11. Semantic locators combining persistent anchors with bounded fallback matching.
12. Native OMML/OMath equation acceptance.
13. Existing RWMCP policy/workspace/interlock/audit as authority.
14. Macros/external active content disabled by default.

## 9. Patterns rejected

- Universal `OfficeObject`, `OfficeNode` or "do anything" abstraction.
- One giant Office service.
- Office represented as a reasoning worker/provider.
- UI automation as primary path.
- Paragraph index as durable Word identity.
- Arbitrary Python, shell, VBA or raw COM invocation from MCP input.
- Automatically attaching to whichever Office process is active.
- Automatically executing macros/external relationships.
- Treating save success as acceptance.
- Hand-implementing full OPC/ISO 29500 in RWMCP.
- Mandatory Office/COM dependency on Linux.
- One MCP tool per formatting property.

## 10. Security implications

Default Office Pack policy:

- Never execute macros automatically.
- Never enable external content automatically.
- Never follow remote relationships during inspection unless a separately authorized capability is introduced.
- Never execute DDE/ActiveX/OLE payloads.
- Never expose arbitrary VBA, shell or raw COM invocation.
- Never change Trust Center settings silently.
- Never enable arbitrary add-ins.
- Detect and report macro-enabled files, embedded OLE/ActiveX, external relationships/remote templates, protection/encryption, hidden sheets/slides and external-link/formula surfaces.
- Classify passive document content separately from active/executable/external content.
- Keep file authorization under existing RWMCP workspace/host-filesystem policy.

COM rules:

- Isolated RWMCP-owned Office process by default for deterministic mutation.
- Live attach requires explicit identity match.
- Close/kill only processes owned by the RWMCP Office session.
- Alert suppression may only cover explicitly handled prompts; it is not a security bypass.

## 11. Tool-surface implications

Recommended initial surface:

- `office_capabilities`
- `office_session_open`
- `office_session_status`
- `office_session_close`
- `word_inspect`
- `word_edit`
- `word_equation`
- `word_table`
- `word_media`
- `word_render`
- `word_validate`

Excel and PowerPoint tools are not registered before their implementation phases.

`word_edit.operations[]` must be a discriminated union, not an arbitrary command payload.

Capability discovery should report:

- domains implemented,
- available backends,
- per-backend capability matrix,
- native Office availability when probed,
- render/export support,
- risky features disabled by policy.

## 12. Transaction model

State machine:

```
OPEN
  -> INSPECTED
  -> SNAPSHOTTED
  -> WORKING
  -> PATCHED
  -> APP_OPENED       (when required)
  -> RENDERED         (when required)
  -> VALIDATED
  -> ACCEPTED
      -> COMMITTED
```

Failure after snapshot transitions to rollback/failure. Hash conflict transitions to `CONFLICT` and never overwrites the original.

A transaction records:

- transaction/session IDs,
- principal + Work Session,
- canonical original path,
- original SHA-256 and useful stat metadata,
- backup path/hash,
- working-copy path/hash,
- selected backend per operation,
- evidence artifacts,
- validation/acceptance results,
- final commit/rollback outcome.

Commit procedure:

1. Recompute original identity/hash.
2. Fail closed if it changed after inspection.
3. Ensure all required acceptance assertions passed.
4. Prefer same-filesystem atomic replacement.
5. Retain bounded backup according to policy.

## 13. Acceptance model

Acceptance is a typed set of assertions, never a free-form AI verdict.

Word initial assertions may include:

- package structurally valid,
- no broken relationships,
- required headings/anchors preserved,
- Word COM open succeeded when native acceptance is required,
- render/PDF export succeeded,
- expected OMath/equation count satisfied,
- target images removed only within declared scope,
- original remains unmodified until commit.

Later Excel assertions:

- workbook opens,
- required sheets/ranges preserved,
- formula error scan,
- native recalculation completed when requested,
- expected table/chart structures present.

Later PowerPoint assertions:

- presentation opens,
- slide/shape counts and required IDs/anchors,
- no missing media,
- snapshot/render success,
- geometry within declared bounds.

## 14. Backend selection strategy

Backend selection is **operation-aware**, not a global fallback switch.

Word examples:

- package/relationship/media inspection -> OOXML.
- supported deterministic text/table mutation -> OOXML/high-level library.
- tracked changes, native OMath verification, final Word open/PDF render -> COM.
- MathType/ribbon-only legacy action -> UI fallback only if explicitly requested later.

Excel examples:

- deterministic range/style/package edit -> OOXML/openpyxl when fidelity permits.
- recalculation, evaluated formula validation, live workbook semantics -> COM.

PowerPoint examples:

- structural slide/shape mutation -> OOXML/python-pptx when supported.
- native render/layout validation -> COM.

A request requiring native semantics must fail closed when native backend is unavailable; it must not silently degrade.

## 15. Proposed module boundaries

Starting boundary:

```
src/
  office/
    common/
      contracts.ts
      capability-matrix.ts
      session-store.ts
      document-identity.ts
      locator.ts
      transaction.ts
      validation.ts
      resource-keys.ts
      render-artifact.ts
    word/
      contracts.ts
      inspector.ts
      locator.ts
      edit.ts
      equation.ts
      tables.ts
      media.ts
      sections.ts
      acceptance.ts
    backends/
      ooxml/
      windows-com/
      ui-fallback/        # later only
  tools/
    office-tools.ts
```

Only truly shared concerns belong in `office/common`; Word Paragraph, Excel Range and PowerPoint Shape remain distinct domain types.

Composition:

- `src/context.ts` constructs Office services.
- `src/capabilities.ts` advertises the pack/tool discovery surface.
- existing execution context owns principal/Work Session identity.
- existing concurrency/resource/interlock facilities protect mutations.
- existing audit infrastructure records actions.

## 16. Compatibility risks

1. **Tool/context growth.** Mitigate with progressive disclosure and bounded typed batches.
2. **Linux startup breakage from COM imports.** Mitigate with lazy optional adapters; no mandatory native Office dependency.
3. **Zombie Office processes.** Explicit COM owner, STA lane, finally cleanup, timeout/crash reconciliation.
4. **OOXML round-trip loss.** Minimal targeted mutations, preserve unknown parts, structural diff + reopen.
5. **Concurrent user edits.** SHA-256 optimistic concurrency + file resource ownership.
6. **Wrong live document.** Canonical path + application/process/session identity.
7. **Equation fidelity loss.** Structural OMML plus native Word OMath acceptance.
8. **Active-content security regression.** Deny-by-default active-content detection/gates.
9. **Regression of 141 existing tools/Control Center/Linux.** Additive registration and full regression gate each phase.

## 17. Recommended phased implementation

### Phase A — Office Core

Implement only typed infrastructure:

- contracts,
- backend capability matrix,
- document identity,
- Office session store,
- semantic locator base types,
- resource keys,
- transaction state machine,
- validation/evidence contracts.

No native Office dependency in the Node process.

### Phase B — Word Inspector

- DOCX structure,
- headings,
- paragraphs,
- tables,
- media,
- equations,
- sections,
- stable/fallback locators.

### Phase C — Word Editing

- bounded typed operations for text/paragraph/style/table/media/section on a working copy.

### Phase D — Equation

- normalized equation representation,
- OMML insertion/replacement,
- Word OMath verification.

### Phase E — Word QA / Acceptance

- native Word open,
- PDF render,
- structural validation,
- scope assertions,
- commit/rollback.

Only after Word acceptance passes:

- Phase F — Excel.
- Phase G — PowerPoint.
- Phase H — optional UI/MathType/add-in fallback.

## Research conclusion

The initial sibling-pack hypothesis is supported by the reference implementations, with one important refinement:

> Office must not use a single global "COM or OOXML" switch. It needs a **domain-aware capability matrix** selecting a backend per requested operation and acceptance requirement.

Final intended direction:

```
ChatGPT / optional Codex / optional Antigravity
                    |
                    v
               RWMCP Core
   identity / policy / Work Session / DAG
   resource / interlock / audit / data plane
             /                  \
    Engineering Pack          Office Pack
                                  |
                    +-------------+-------------+
                    |             |             |
                   Word          Excel       PowerPoint
                    |             |             |
                 capability-aware backend selection
                    |             |             |
                  COM         OOXML/headless   UI fallback
```

Office Pack is deterministic execution infrastructure, not a new reasoning agent.

## 18. v0.33.0 implementation checkpoint

The evidence-backed architecture has now been implemented through Word Phase E without starting Excel or PowerPoint prematurely.

Implemented boundaries:

- Office remains a sibling capability pack under `src/office`, with no dependency from Engineering into Office.
- `office_capabilities`, `word_inspect`, and transactional `word_edit` are the only Office MCP tools exposed in this milestone.
- Action Schema advances to 12; Engineering API remains 5.
- OOXML supplies deterministic package inspection and typed working-copy mutation.
- Windows COM supplies native Word open, OMath verification, PDF render and native-process cleanup.
- Linux requires no Microsoft Office dependency and retains the OOXML subset.
- `.docx` mutation uses explicit Work Session ownership, a stable file lease, backup, working copy, SHA-256 conflict detection, structural acceptance and explicit rollback.
- Word equations are native OMML/OMath rather than images; MathType remains optional and absent from the required path.
- Macro-enabled mutation, ActiveX, embedded OLE, remote templates, arbitrary VBA/shell/raw-COM and implicit UI automation remain fail-closed.

Acceptance evidence is recorded in `docs/architecture/office-word-acceptance.md`. The pre-release repository gate reached 447 tests / 445 PASS / 0 FAIL / 2 SKIP with typecheck, build, plugin validation, diff check and production dependency audit all passing. Excel remains blocked until the v0.33.0 Word release is accepted on production nodes.
