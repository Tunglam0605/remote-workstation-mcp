# Engineering Tool Benchmark and Adoption Notes

Checked: 2026-09-20

This document records upstream patterns used to evolve RWMCP engineering tooling. It is intentionally an engineering reference, not an authority source and not a request to copy upstream implementations.

## Architecture rule

ChatGPT Web remains responsible for reasoning, planning, architecture and engineering judgement. RWMCP exposes deterministic, typed, bounded execution/introspection primitives. Upstream patterns are adopted only when they preserve that boundary.

## ESP-IDF / Espressif

References:
- https://github.com/espressif/esp-idf
- https://github.com/espressif/esptool
- https://github.com/espressif/vscode-esp-idf-extension

Patterns to adopt:
- Prefer generated structured build metadata over scraping build logs.
- Consume project_description.json, flasher_args.json and config/sdkconfig.json when present.
- Keep target/port selection explicit for flashing.
- Separate build, flash, monitor, size/metadata and doctor/preflight operations.
- Preserve esptool/idf.py as the upstream authority for chip/flash semantics.
- Return bounded metadata and never expose eFuse/security mutation implicitly.

RWMCP application:
- Enrich espidf.diagnostics with build metadata and supported-target discovery.
- Later add bounded size analysis and explicit chip/flash identity inspection.
- Keep erase/eFuse/security mutation outside default engineering workflows.

## ROS 2 / colcon / rosbag2

References:
- https://github.com/ros2/ros2cli
- https://github.com/ros2/rosbag2
- https://github.com/colcon/colcon-core

Patterns to adopt:
- Model CLI surfaces as command + verb with extension boundaries.
- Keep graph introspection separate from runtime mutation.
- Treat ros2 doctor output as an opaque bounded upstream diagnostic report unless a stable structured format exists.
- Keep colcon package selection explicit and bounded.
- Give rosbag record/playback explicit lifecycle ownership.

RWMCP application:
- Add ros2.doctor as a read-only workflow through the existing workflow envelope.
- Extend bag tooling later with info/playback/lifecycle contracts rather than arbitrary ros2 argv.

## Docker

Reference:
- https://github.com/docker/cli

Patterns to adopt:
- Prefer JSON output (inspect, stats --format json) and object-specific commands.
- Preserve Docker context identity because a remote daemon changes the risk boundary.
- Keep shell/interpreter exec blocked and use direct executable argv.

RWMCP application:
- Add a bounded one-shot runtime stats snapshot workflow.
- Continue daemon/context and container risk assessment before mutation.

## systemd

Reference:
- https://github.com/systemd/systemd

Patterns to adopt:
- Use systemctl show for machine-parsable unit properties instead of parsing human status output.
- Use journalctl JSON output for structured bounded log tails.
- Do not invent a stable parser for systemd-analyze verify free-form diagnostics.
- Restart remains exact-unit, explicit-owner-allowlist and full-control gated.

RWMCP application:
- Enrich unit diagnostics with invocation/restart/resource properties.
- Return structured bounded journal entries with a compatibility fallback.
- Consider systemd-analyze verification only as opaque diagnostics until upstream has a stable machine interface.

## KiCad / KiBot

References:
- https://github.com/KiCad/kicad-source-mirror
- https://github.com/INTI-CMNB/KiBot

Patterns to adopt:
- Treat schematic/PCB validation and fabrication generation as reproducible pipelines.
- DRC/ERC are preflight gates, not UI automation.
- Keep generated fabrication artifacts isolated from source and auditable.
- Prefer kicad-cli/KiBot contracts over GUI clicking when equivalent CLI capability exists.

RWMCP application:
- Next phase: detect KiCad projects, add read-only diagnostics, DRC/ERC preflight and bounded export plans.
- Any source-modifying PCB operation must remain explicit and reviewable.

## Explicit non-goals

- No autonomous architecture decisions.
- No arbitrary shell recipes hidden inside workflows.
- No implicit device selection for destructive actions.
- No broad systemd service restart surface.
- No Docker shell escape.
- No ESP eFuse/security mutation as a normal workflow.
- No parsing unstable human output into falsely authoritative structured fields.
