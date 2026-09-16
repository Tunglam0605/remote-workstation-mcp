# RWMCP Engineering Tools v0.9 Design

## Goal
Turn recurring workstation engineering operations into typed, policy-aware MCP tools so ChatGPT and future agents reuse stable contracts instead of composing arbitrary shell commands.

## Architecture
RWMCP keeps the control-plane boundary: authenticated MCP tool -> policy/scope gate -> typed engineering adapter -> constrained provider/runner -> local runtime or hardware. Provider implementations generate argv with `shell=false`; raw shell remains a separately elevated escape hatch.

Core units:
- Hardware discovery + exclusive resource leases for serial/debug probes.
- PTY/ConPTY sessions with caller ownership, bounded I/O and lifecycle cleanup.
- Firmware project/artifact inspection plus typed build/flash/verify/reset providers.
- OpenOCD + GDB/MI debug sessions with loopback-only servers and no arbitrary GDB/TCL command surface.
- Serial, ROS 2 and Docker typed adapters.
- Shared security classification through workstation scopes and local engineering policy gates.

## Safety invariants
- Workspace/project path containment is mandatory.
- Multiple probes require explicit selection; auto-selection is only permitted when discovery is unambiguous.
- Flash/reset/debug/ROS 2 mutations/container mutations require hardware-mutation permission.
- No mass erase, Option Bytes, eFuse writes, arbitrary memory writes, arbitrary TCL/GDB commands or GDB flashing in v0.9.0.
- Serial writes are separately policy-gated.
- OpenOCD target config is restricted to `target/*.cfg` identifiers.
- Container exec rejects shell/interpreter hosts that would recreate arbitrary command strings.
- Output, input, runtime, cursor and session ownership are bounded.

## Provider strategy
Stable semantic contracts sit above providers. Initial providers are OpenOCD/ST-Link, GDB/MI, ESP-IDF, CMake/Make, ros2cli and Docker CLI. Future provider swaps must not change the top-level MCP contract unless capability semantics change.

## Distribution
Native Node modules (`node-pty`, `serialport`) are pinned and must load from packed release installs using the same `--ignore-scripts` behavior as managed installers. Windows and Linux are release gates.

## Acceptance
A release requires typecheck, full tests, build, plugin validation, packed-artifact native smoke, Windows acceptance, Linux acceptance, CI, release publication, managed-node upgrade and post-upgrade `chatgpt_web_status` verification.
