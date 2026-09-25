# Professional Tooling Vendor Reference Audit

Status: v0.44.1 hardening review  
Baseline reviewed: v0.44.0 / Action Schema 20 / Engineering API 5  
Scope: existing professional tooling only. This review deliberately adds no new tool domain.

## Review principles

1. Prefer official vendor CLI/API semantics over locally invented equivalents.
2. Keep RWMCP typed and bounded: no arbitrary GDB/TCL/ROS/KiCad/COM/VBA command passthrough.
3. Do not claim stronger guarantees than the upstream tool actually provides.
4. A diagnostic must state what it measures, not merely return a number.
5. Mutation must fail closed when preserving document/project semantics cannot be proven.
6. Native acceptance is evidence, not an authority bypass; Work Session ownership, leases, optimistic concurrency, rollback and hardware interlocks remain authoritative.

## Primary upstream references

| Domain | Official/upstream reference |
| --- | --- |
| OpenOCD | https://openocd.org/doc/html/Flash-Programming.html |
| OpenOCD source/docs | https://github.com/openocd-org/openocd |
| GDB/MI break/watch commands | https://sourceware.org/gdb/current/onlinedocs/gdb.html/GDB_002fMI-Breakpoint-Commands.html |
| GDB watchpoints | https://sourceware.org/gdb/current/onlinedocs/gdb.html/Set-Watchpoints.html |
| GDB/MI stack variables | https://sourceware.org/gdb/current/onlinedocs/gdb.html/GDB_002fMI-Stack-Manipulation.html |
| GDB/MI disassembly | https://sourceware.org/gdb/current/onlinedocs/gdb.html/GDB_002fMI-Data-Manipulation.html |
| STM32CubeProgrammer | https://www.st.com/en/development-tools/stm32cubeprog.html |
| ROS 2 CLI | https://github.com/ros2/ros2cli |
| tf2 tools | https://docs.ros.org/en/rolling/Tutorials/Intermediate/Tf2/Debugging-Tf2-Problems.html |
| ROS 2 lifecycle | https://github.com/ros2/rcl_interfaces/tree/rolling/lifecycle_msgs |
| KiCad CLI | https://docs.kicad.org/master/en/cli/cli.html |
| Open XML SDK | https://github.com/dotnet/Open-XML-SDK |
| Excel Workbooks.Open | https://learn.microsoft.com/en-us/office/vba/api/excel.workbooks.open |
| Office AutomationSecurity | https://learn.microsoft.com/en-us/office/vba/api/office.msoautomationsecurity |
| Excel CalculateFullRebuild | https://learn.microsoft.com/en-us/office/vba/api/excel.application.calculatefullrebuild |
| PowerPoint Presentations.Open | https://learn.microsoft.com/en-us/office/vba/api/powerpoint.presentations.open |
| PowerPoint Presentation.SaveAs | https://learn.microsoft.com/en-us/office/vba/api/powerpoint.presentation.saveas |

## Findings and decisions

| Area | v0.44 implementation | Audit finding | Decision / hardening |
| --- | --- | --- | --- |
| OpenOCD flash/deploy | Explicit `init`, `reset halt`, `program ... verify`; deploy then called `verify_image` again | Upstream `program ... verify reset exit` already owns init/program/verify/reset/exit. Deploy was verifying twice. | **HARDENED**: use one upstream program helper transaction; keep standalone `firmware_verify` as the explicit independent verify tool. |
| GDB watchpoints | Every `-break-watch` result labelled `hardware-watchpoint` | Default write watchpoint may fall back to software; read/access watchpoints require hardware support. | **HARDENED**: return generic `watchpoint`; report `hardwareGuaranteed=true` only for read/access modes. |
| GDB locals | `-stack-list-variables --simple-values` | Aligned with current MI contract and avoids deprecated split locals/arguments flow. | **KEEP**. |
| GDB disassembly | Bounded `-data-disassemble` around PC/address | Valid MI contract. Mode `-- 0` is legacy/deprecated but maximizes compatibility with embedded GDB versions. | **KEEP for compatibility**, revisit after minimum GDB version is explicit. |
| ROS 2 topic Hz/BW | Bounded official `ros2 topic hz/bw` subprocess sampled until timeout | Values are subscriber-observed receive rate/bandwidth and can be affected by QoS, Python/rclpy scheduling and host load; they are not publisher clock truth/link capacity. | **HARDENED**: return explicit measurement semantics and caveats with every sample. |
| ROS 2 TF | Bounded `tf2_echo source target` and parsed translation/quaternion | Matches official TF2 diagnostic workflow. | **KEEP**. |
| ROS 2 action goal | Intentionally not exposed | CLI process timeout/kill does not prove server-side goal cancellation. | **DEFER** until durable goal UUID, cancellation and restart recovery exist. |
| KiCad DRC/ERC | Typed JSON reports, bounded parser, no source save/refill | Correct CLI direction. Fabrication gate did not request schematic parity and only used severity-error totals. | **HARDENED**: request `--schematic-parity` when board+schematic exist; fabrication blocks active errors, active unconnected items and active parity findings. Excluded findings stay excluded. |
| KiCad BOM | Fixed `Reference,Value,Footprint,QUANTITY,DNP` fields and labels | Matches KiCad CLI's standard BOM field contract; no arbitrary plugin/script. | **KEEP**. |
| KiCad fabrication | New isolated output directory, DRC/ERC gate, Gerbers/drill/BOM, SHA-256 manifest | Safe source-preserving model. Zone refill on the source board would violate no-source-mutation. | **KEEP**; any future refill must occur on an isolated copy, never source. |
| Excel OOXML | Typed `.xlsx` cell/range/formula mutation with transaction/rollback | Architecture is sound, but formula validation blocked all bracket references (including safe structured refs) while missing side-effect formulas. Native recalculation can execute external-data formulas. | **HARDENED**: allow normal structured refs; block external workbook refs, DDE, external-data/link/native-code formula functions; scan all existing formulas and defined names before native Excel open/recalc. |
| Excel native COM | Read-only open, links off, events off, ForceDisable macros, CalculateFullRebuild, formula error count/PDF | Vendor guidance recommends changing AutomationSecurity immediately before Open and restoring it immediately afterwards. | **HARDENED**: save/set/restore AutomationSecurity around `Workbooks.Open`; retain dedicated hidden process and static formula gate. |
| PowerPoint OOXML | Existing title/shape text replacement rebuilt text body and preserved only first run properties | Could silently lose paragraph properties, bullets, alignment, hyperlinks and mixed-run formatting while structural counts remained unchanged. | **HARDENED**: update existing text nodes in-place for simple one-run paragraphs; preserve paragraph/run/end properties; fail closed on paragraph reshaping, mixed runs, fields, breaks or hyperlinks. |
| PowerPoint native COM | Read-only hidden Open, ForceDisable macros, PDF SaveAs | API usage is aligned; AutomationSecurity lifecycle should follow vendor guidance. | **HARDENED**: save/set/restore AutomationSecurity around `Presentations.Open`; retain read-only source and separate PDF destination. |
| OOXML package layer | Custom bounded OPC/ZIP/XML parser | Correct architecture for deterministic Node runtime, but schema conformance is manually enforced. | **KEEP**; **DEFER** optional Windows acceptance using official Open XML SDK validator as an additional verifier, not replacement for typed RWMCP operations. |

## Architecture assessment

### Keep as-is

- typed adapter boundary instead of arbitrary command passthrough;
- explicit workspace/path validation;
- hardware/resource leases and owner-scoped Work Sessions;
- bounded stdout/report/package parsing;
- source-preserving KiCad diagnostics/fabrication outputs;
- Office SHA-256 optimistic concurrency, working copy, backup, acceptance and owner-scoped rollback;
- action-goal dispatch remaining unavailable until cancellation/recovery semantics are durable.

### Hardened in this maintenance phase

- OpenOCD duplicate verification and redundant program-stage orchestration;
- GDB watchpoint guarantee wording;
- ROS 2 Hz/BW measurement semantics;
- KiCad board/schematic parity and active fabrication blockers;
- Excel external/side-effect formula policy, including existing workbook scan;
- Excel/PowerPoint AutomationSecurity lifecycle;
- PowerPoint formatting fidelity and fail-closed behavior.

### Deliberately deferred

- STM32CubeProgrammer as an optional ST-native provider. It is a useful future backend for production/ST-specific workflows, but must not broaden Option Bytes/RDP/mass-erase authority.
- GDB modern disassembly flags until the minimum supported Arm GDB version is explicit.
- ROS 2 action goal send/cancel until durable goal-handle recovery exists.
- a native C++ ROS 2 rate sampler for very high-rate topics; current CLI tool remains useful with honest semantics.
- KiCad refill-zones fabrication on a temporary board copy.
- official Open XML SDK validation as an optional Windows acceptance stage.
- rich PowerPoint formatting edits; text-only mutation remains conservative rather than lossy.

## Acceptance required before v0.44.1 release

- targeted engineering hardening tests;
- targeted Excel/PowerPoint safety/fidelity tests;
- live Windows Excel recalculation/PDF smoke;
- live Windows PowerPoint read-only open/PDF smoke;
- full `npm test` with zero failures;
- TypeScript typecheck;
- production build;
- plugin validation;
- `git diff --check`;
- Windows and Linux CI before merge.
