# Professional Tooling Vendor Audit

Baseline audited: `v0.44.0` / Action Schema 20 / Engineering API 5.

This audit compares RWMCP professional tools with upstream vendor documentation and source. The purpose is to harden semantics before adding more tools.

## Decision matrix

| Area | Current strategy | Vendor-reference decision | Action |
| --- | --- | --- | --- |
| OpenOCD STM32 deploy | Fixed allowlisted CLI, ST-Link lease, `program ... verify`, plus an extra `verify_image` | `program ... verify` already performs `verify_image`; repeating it in the same deploy is redundant | **HARDEN**: remove duplicate verify; keep `firmware.verify` as an explicit independent operation |
| GDB/MI debug | Fixed MI commands; no arbitrary GDB; no memory write | `-break-watch [-a|-r]`, `-stack-list-variables --simple-values`, and `-data-disassemble` are documented MI commands | **KEEP** architecture; continue bounded parser tests |
| ROS 2 topic Hz/BW | Bounded `ros2 topic hz/bw` subprocess and parser | Upstream defines these as rates/bandwidth observed by the subscription; QoS and host resources can affect results | **HARDEN** semantics metadata; expose `--wall-time` for Hz; do not call result publisher-side truth |
| ROS 2 TF/lifecycle | Fixed `tf2_echo` / lifecycle verbs | Appropriate operator diagnostics; output is human-oriented rather than a formal machine protocol | **KEEP/HARDEN**; parser fixtures per supported ROS distro; consider rclpy helper only if output drift becomes material |
| KiCad DRC/ERC/BOM | Fixed `kicad-cli`, temporary JSON/CSV output | DRC/ERC JSON and BOM fields/labels are documented in KiCad 9+ | **KEEP** |
| KiCad board stats | `pcb export stats --format json` | Documented in KiCad 10/master; not treated as universal across older KiCad releases | **HARDENED**: provider probes `pcb export stats --help`; direct stats fails clearly when unsupported and broad diagnostics degrade without stats |
| Excel OOXML | Typed OOXML cell/range/formula patch + native acceptance | SpreadsheetML formula/cell representation matches Open XML documentation | **KEEP** architecture |
| Excel COM acceptance | `UpdateLinks=0`, read-only open, events disabled, `AutomationSecurity=ForceDisable`, full recalc | Microsoft documents `UpdateLinks=0`; macros are enabled by default for programmatic opens unless AutomationSecurity is changed; security setting should be restored | **HARDEN**: save/restore AutomationSecurity around open |
| PowerPoint OOXML | Existing title/shape text only, structural invariants | Conservative OOXML mutation surface | **KEEP** |
| PowerPoint COM acceptance | read-only hidden open, forced macro disable, PDF output | Microsoft documents programmatic read-only open and AutomationSecurity; setting should be restored | **HARDEN**: save/restore AutomationSecurity around open |


## Live acceptance evidence

- Windows Excel 16.0: programmatic read-only open, full recalculation and PDF export passed after AutomationSecurity save/restore hardening; formula error count was 0 and PDF output was 72,204 bytes.
- Windows PowerPoint 16.0: hidden read-only open and PDF export passed after AutomationSecurity save/restore hardening; PDF output was 5,765 bytes.
- Windows KiCad 10.0.6: `pcb export stats --help` succeeded and advertises `--format`; capability probing therefore enables board statistics on the production workstation.
- Word source/helper contract is regression-tested with narrowed AutomationSecurity scope. A live Word smoke was not used as acceptance evidence because a pre-existing Word Automation COM process prevented a clean isolated smoke; audit-created Word processes were identified by creation time and cleaned without touching the pre-existing process.

## Primary upstream references

- OpenOCD Flash Programming: https://openocd.org/doc/html/Flash-Programming.html
- OpenOCD Flash Commands: https://openocd.org/doc/html/Flash-Commands.html
- GDB/MI Breakpoint Commands: https://sourceware.org/gdb/current/onlinedocs/gdb.html/GDB_002fMI-Breakpoint-Commands.html
- GDB/MI Stack Manipulation: https://sourceware.org/gdb/current/onlinedocs/gdb.html/GDB_002fMI-Stack-Manipulation.html
- GDB/MI Data Manipulation: https://sourceware.org/gdb/current/onlinedocs/gdb.html/GDB_002fMI-Data-Manipulation.html
- ROS 2 CLI upstream: https://github.com/ros2/ros2cli
- ROS 2 `hz` implementation: https://github.com/ros2/ros2cli/blob/rolling/ros2topic/ros2topic/verb/hz.py
- KiCad 9 CLI: https://docs.kicad.org/9.0/en/cli/cli.html
- KiCad 10 CLI: https://docs.kicad.org/10.0/en/cli/cli.html
- Excel Workbooks.Open: https://learn.microsoft.com/en-us/office/vba/api/excel.workbooks.open
- Excel AutomationSecurity: https://learn.microsoft.com/en-us/office/vba/api/excel.application.automationsecurity
- Excel CalculateFullRebuild: https://learn.microsoft.com/en-us/office/vba/api/excel.application.calculatefullrebuild
- PowerPoint AutomationSecurity: https://learn.microsoft.com/en-us/office/vba/api/powerpoint.application.automationsecurity
- PowerPoint Presentations.Open: https://learn.microsoft.com/en-us/office/vba/api/powerpoint.presentations.open
- PowerPoint ExportAsFixedFormat: https://learn.microsoft.com/en-us/office/vba/api/powerpoint.presentation.exportasfixedformat
- PowerPoint ppSaveAsPDF (32): https://learn.microsoft.com/en-us/office/vba/api/powerpoint.ppsaveasfiletype
- Open XML formulas: https://learn.microsoft.com/en-us/office/open-xml/spreadsheet/working-with-formulas
- Open XML sheets: https://learn.microsoft.com/en-us/office/open-xml/spreadsheet/working-with-sheets

## Follow-up audit backlog

1. Validate ROS 2 text parsers against Humble and the currently supported distro matrix; do not replace CLI with rclpy until the helper has a stable JSON contract and lifecycle/cancellation behavior.
2. Replace regex-only GDB/MI result parsing with a small bounded MI grammar if upstream output variations begin to break fixtures.
3. Add SVD/peripheral register metadata and RTOS introspection only as separate typed adapters; do not expose arbitrary monitor/GDB commands.
4. Keep Office macro/template formats inspection-only until active-content/XLM handling has a dedicated threat model.
