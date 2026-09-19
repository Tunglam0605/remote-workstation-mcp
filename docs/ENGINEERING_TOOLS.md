# Engineering Tools

RWMCP keeps domain engineering tools typed and project-aware. Starting in v0.14, generic cross-node transfer is explicitly a **core platform capability**, not an engineering/firmware capability. v0.14.1 adds bounded multi-endpoint direct fallback; v0.14.2 adds a bounded control-plane relay fallback for independently reachable nodes with no mutual route. Neither change moves transport back into a firmware-specific layer. The existing `engineering_workflow_*` MCP actions remain the stable workflow envelope for both `platform.*` and engineering workflow IDs until a future action-schema change is intentionally justified.

For generic Direct-Node file transfer, use `platform.transfer_prepare`, `platform.transfer_receive_offer`, and `platform.transfer_push` first. When direct peer routing is unavailable, use the `platform.relay_*` workflows as the bounded fallback; see [DATA_PLANE.md](DATA_PLANE.md). Firmware keeps local artifact integrity prepare/accept workflows, but peer byte movement uses only the secured generic platform data plane.

## Tool families

- `engineering_*`: inspect a project, create/load `.rwmcp/project.yaml`, list/plan/run approved high-level workflows.
- `hardware_*`: discover serial ports/debug probes and inspect exclusive resource leases.
- `serial_*`: caller-owned bounded serial monitoring, readiness-marker waiting and policy-gated writes.
- `terminal_*`: true PTY/ConPTY sessions with bounded I/O. v0.14.4 isolates native `node-pty` in a per-session worker subprocess so a native ConPTY leak/crash cannot take down the MCP host.
- `firmware_*` / `target_reset`: inspect, build, plan, flash, independently verify and reset firmware through constrained providers.
- `debug_*` / `fault_decode`: OpenOCD + GDB/MI debugging, Cortex-M register/memory/fault inspection.
- `ros2_*`: typed colcon build plus bounded node/topic/QoS/service/action/parameter/bag operations.
- `container_*` / `image_build`: typed Docker lifecycle, logs, exec and build operations.

## High-level workflow catalog

### Firmware artifact integrity

- `firmware.artifact_prepare`
- `firmware.artifact_accept`

`firmware.artifact_prepare` resolves one project-relative ELF/AXF/HEX/BIN file, hashes it and returns a canonical SHA-256/size manifest without modifying the file. `firmware.artifact_accept` re-hashes staged bytes at the destination, blocks on SHA-256 or size mismatch, then stream-copies to a temporary file and atomically renames only verified content into `.rwmcp/artifacts/verified/<sha256>-<name>`.

The older firmware-specific peer-transfer workflow IDs are intentionally not advertised from v0.14.3 onward. Keeping a second transport path would bypass the single generic cross-node authorization boundary. Cross-node firmware bytes therefore use `platform.transfer_*` or `platform.relay_*`, while firmware integrity remains a separate domain concern.

### STM32

- `firmware.build`
- `firmware.build_flash`
- `firmware.build_flash_verify`
- `stm32.debug_fault_snapshot`
- `stm32.deploy_accept`

`firmware.build_flash_verify` performs a normal constrained flash transaction and then a separate OpenOCD `verify_image` acceptance pass. `stm32.debug_fault_snapshot` requires an explicit/persisted ST-Link serial and one unambiguous ELF/AXF symbols artifact, opens a loopback-only OpenOCD/GDB-MI session, halts the core, captures Cortex-M fault state and stack frames, then closes the session and releases the probe.

`stm32.deploy_accept` is the daily-driver deployment path: it performs provider/hardware/serial preflight and then actively proves the selected ST-Link can be opened through a bounded adapter-only OpenOCD SWD check before build. This access check takes a short exclusive probe lease, uses the configured adapter speed, may report target voltage, and releases the lease immediately afterward; it enables bounded OpenOCD debug output so external ownership can be classified reliably, but it does not load a target config or issue reset, halt, or program commands. External ownership is classified as `probe-busy`, while permission and not-found failures remain distinct. Only after preflight succeeds does the workflow build the selected variant, open serial before reset, and execute flash + independent verify + reset inside one OpenOCD process while one ST-Link lease is held. It waits for the configured readiness marker and closes the serial session in `finally` by default. Any failed provider/probe/serial preflight returns `blocked` before build/flash instead of falling back to shell.

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

v0.13 proves this contract for engineering growth. v0.14.0 reuses the same generic workflow + `parameters` envelope for core `platform.transfer_*` workflow IDs, so `actionSchemaVersion` remains `2` and `engineeringApiVersion` remains `3` without adding a new top-level ChatGPT action.
