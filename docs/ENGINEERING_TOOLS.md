# Engineering Tools

RWMCP v0.9 introduces typed engineering operations so routine embedded, robotics and workstation tasks do not need arbitrary shell strings.

## Tool families

- `hardware_*`: discover serial ports/debug probes and inspect exclusive resource leases.
- `serial_*`: caller-owned bounded serial monitoring and policy-gated writes.
- `terminal_*`: true PTY/ConPTY sessions with bounded I/O.
- `firmware_*` / `target_reset`: inspect, build, plan, flash, verify and reset firmware through constrained providers.
- `debug_*` / `fault_decode`: OpenOCD + GDB/MI debugging, Cortex-M register/memory/fault inspection.
- `ros2_*`: bounded node/topic/service/action/parameter/bag workflows.
- `container_*` / `image_build`: typed Docker lifecycle, logs, exec and build operations.

## Initial providers

- STM32: OpenOCD/ST-Link and `arm-none-eabi-gdb`/GDB-MI.
- ESP32: ESP-IDF (`idf.py`) with deterministic environment activation.
- Generic builds: CMake and Make.
- ROS 2: `ros2cli` typed argv contracts.
- Containers: Docker CLI typed argv contracts.

## Safety model

Engineering tools do not bypass RWMCP policy. Read-only discovery/inspection remains separate from execution and hardware mutation. Workspace/project containment, explicit probe/port identity, exclusive leases, bounded input/output/runtime and authenticated MCP scopes apply before provider execution.

v0.9.0 intentionally does **not** expose mass erase, STM32 Option Bytes, ESP eFuse writes, arbitrary OpenOCD TCL, arbitrary GDB commands, target memory writes or GDB flashing.

## Why typed tools

The stable tool contract can be improved internally without changing how ChatGPT uses it. A future `firmware_flash` implementation may select a different verified provider while preserving the same policy, audit and result model.
