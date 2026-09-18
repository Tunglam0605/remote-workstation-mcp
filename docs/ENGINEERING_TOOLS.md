# Engineering Tools

RWMCP v0.13 extends the typed engineering layer so recurring STM32, Keil MDK, ESP-IDF and ROS 2 work can be represented as persistent project profiles plus semantic workflows instead of repeated shell sequences.

## Tool families

- `engineering_*`: inspect a project, create/load `.rwmcp/project.yaml`, list/plan/run approved high-level workflows.
- `hardware_*`: discover serial ports/debug probes and inspect exclusive resource leases.
- `serial_*`: caller-owned bounded serial monitoring, readiness-marker waiting and policy-gated writes.
- `terminal_*`: true PTY/ConPTY sessions with bounded I/O.
- `firmware_*` / `target_reset`: inspect, build, plan, flash, independently verify and reset firmware through constrained providers.
- `debug_*` / `fault_decode`: OpenOCD + GDB/MI debugging, Cortex-M register/memory/fault inspection.
- `ros2_*`: typed colcon build plus bounded node/topic/QoS/service/action/parameter/bag operations.
- `container_*` / `image_build`: typed Docker lifecycle, logs, exec and build operations.

## High-level workflow catalog

### STM32

- `firmware.build`
- `firmware.build_flash`
- `firmware.build_flash_verify`
- `stm32.debug_fault_snapshot`
- `stm32.deploy_accept`

`firmware.build_flash_verify` performs a normal constrained flash transaction and then a separate OpenOCD `verify_image` acceptance pass. `stm32.debug_fault_snapshot` requires an explicit/persisted ST-Link serial and one unambiguous ELF/AXF symbols artifact, opens a loopback-only OpenOCD/GDB-MI session, halts the core, captures Cortex-M fault state and stack frames, then closes the session and releases the probe.

`stm32.deploy_accept` is the daily-driver deployment path: it performs provider/hardware/serial preflight and then actively proves the selected ST-Link can be opened through a bounded adapter-only OpenOCD SWD check before build. This access check takes a short exclusive probe lease, uses the configured adapter speed, may report target voltage, and releases the lease immediately afterward; it does not load a target config or issue reset, halt, or program commands. External ownership is classified as `probe-busy`, while permission and not-found failures remain distinct. Only after preflight succeeds does the workflow build the selected variant, open serial before reset, and execute flash + independent verify + reset inside one OpenOCD process while one ST-Link lease is held. It waits for the configured readiness marker and closes the serial session in `finally` by default. Any failed provider/probe/serial preflight returns `blocked` before build/flash instead of falling back to shell.

### ESP-IDF

- `firmware.build`
- `firmware.build_flash`
- `firmware.build_flash_monitor`
- `firmware.build_flash_monitor_expect`

The monitor-expect workflow persists serial port/baud/readiness marker in `.rwmcp/project.yaml` and uses `serial_wait_for_text` internally, eliminating repeated chat polling while keeping output and timeout bounded.

### ROS 2

- `ros2.build`
- `ros2.health`
- `ros2.build_health`

ROS build configuration accepts only typed fields such as `symlinkInstall`, `mergeInstall`, and a bounded `packagesSelect` list. It does not accept arbitrary colcon arguments or shell strings. `ros2_topic_info` provides verbose endpoint/QoS inspection.

## Initial providers

- STM32 build: CMake/Make plus Keil MDK µVision `.uvprojx` batch builds on Windows. Multi-target Keil projects are represented as explicit profile variants; RWMCP refuses to guess when more than one variant is available.
- STM32 flash/debug: OpenOCD/ST-Link and `arm-none-eabi-gdb`/GDB-MI.
- ESP32: ESP-IDF (`idf.py`) with deterministic environment activation.
- Generic builds: CMake and Make.
- ROS 2: `colcon` + `ros2cli` typed argv contracts.
- Containers: Docker CLI typed argv contracts.

## Project profile examples

Keil MDK multi-target STM32:

```yaml
version: 1
id: b300-main-custom
kind: stm32
firmware:
  buildProvider: keil
  flashProvider: openocd
  defaultVariant: main-v2-f407
  variants:
    main-v2-f407:
      keilProject: Main_V2_F407.uvprojx
      keilTarget: Main_V2_F407
      buildDir: Objects/F407
      artifact: Objects/F407/Main_V2_F407.axf
      targetConfig: target/stm32f4x.cfg
    main-v3-h743:
      keilProject: Main_V3_H743.uvprojx
      keilTarget: Main_V3_H743
      buildDir: Objects/H743
      artifact: Objects/H743/Main_V3_H743.axf
      targetConfig: target/stm32h7x.cfg
```

The Keil provider generates the batch argv internally. Project profiles cannot contain `UV4.exe`, arbitrary command strings or arbitrary command-line arguments. The compatibility baseline uses `-j0 -b <project> -t<target> -o<log>`; this was accepted on the B300 workstation with µVision 5.31. The newer `-sg` option is deliberately not forced because that installed version returns a non-build exit code when it is present.

ESP-IDF:

```yaml
version: 1
id: callbox
kind: esp-idf
firmware:
  buildProvider: esp-idf
  buildDir: build
  flashProvider: esp-idf
  port: COM7
  monitor:
    port: COM7
    baudRate: 115200
    expectText: APP_READY
    expectTimeoutMs: 10000
```

ROS 2:

```yaml
version: 1
id: robot-ws
kind: ros2
ros2:
  distro: humble
  cwd: .
  workspaceSetup: install/setup.bash
  domainId: 10
  build:
    symlinkInstall: true
    mergeInstall: false
    packagesSelect:
      - robot_bringup
      - robot_control
```

## Safety model

Engineering tools do not bypass RWMCP policy. Read-only discovery/inspection remains separate from execution and hardware mutation. Workspace/project containment, explicit probe/port identity, exclusive leases, bounded input/output/runtime and authenticated MCP scopes apply before provider execution.

Project manifests are data-only. They cannot contain executable paths, shell commands, arbitrary OpenOCD TCL, arbitrary GDB commands, arbitrary colcon arguments, STM32 Option Byte/RDP operations, ESP eFuse writes, target memory writes or mass-erase recipes.

## Why typed workflows

The stable semantic contract lets ChatGPT ask for intent such as “build, flash, verify” or “build ROS workspace and check graph health” instead of rebuilding a shell recipe in every conversation. Provider implementation can evolve internally without changing the project-level workflow contract.

Starting with action schema v2, `engineering_workflow_plan` and `engineering_workflow_run` accept a bounded semantic workflow ID plus a server-validated `parameters` object. `engineering_profile_init` also accepts a versioned server-validated `profile` object. This keeps the ChatGPT action surface stable while providers/workflow IDs evolve; only an `actionSchemaVersion` bump requires the custom-app action catalog to be refreshed.

v0.13 proves this contract: `actionSchemaVersion` remains `2`, while `engineeringApiVersion=3` adds `stm32.deploy_accept` and the new runtime-only `parameters.keepMonitorOpen` option without adding a new top-level ChatGPT action or changing the frozen legacy `overrides` schema.
