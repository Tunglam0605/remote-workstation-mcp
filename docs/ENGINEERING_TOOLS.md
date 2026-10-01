# Engineering Tools

RWMCP keeps domain engineering tools typed and project-aware. Starting in v0.14, generic cross-node transfer is explicitly a **core platform capability**, not an engineering/firmware capability. v0.14.1 adds bounded multi-endpoint direct fallback; v0.14.2 adds a bounded control-plane relay fallback for independently reachable nodes with no mutual route. Neither change moves transport back into a firmware-specific layer. The existing `engineering_workflow_*` MCP actions remain the stable workflow envelope for both `platform.*` and engineering workflow IDs until a future action-schema change is intentionally justified.

v0.15 adds Work Session attribution around the engineering framework without turning the session into a permission source. Session-aware process/PT​Y/serial/debug/resource/workflow operations are owned by `principalId + workSessionId`; callers that omit the ID use an implicit compatibility session. Writable repository sessions should prepare an isolated worktree/build directory first. Keil shared-output builds additionally take a project/variant-exclusive `building` lease. `engineering_workflow_run` persists only bounded run metadata and reconciles interrupted runs after runtime restart.

Action Schema v8 / Engineering API v5 add the first Phase-E engineering-depth surface: `stm32_ioc_inspect` is a dedicated bounded read-only STM32 CubeMX metadata tool. Existing Work Session attribution, workflow/resource ownership and typed mutation boundaries remain unchanged. The workflow ID + generic `parameters` envelope remains the preferred extension point for high-level executable workflows.

For generic Direct-Node file transfer, use `platform.transfer_prepare`, `platform.transfer_receive_offer`, and `platform.transfer_push` first. When direct peer routing is unavailable, use the `platform.relay_*` workflows as the bounded fallback; see [DATA_PLANE.md](DATA_PLANE.md). Firmware keeps local artifact integrity prepare/accept workflows, but peer byte movement uses only the secured generic platform data plane.

## Vendor-reference gate for engineering depth

Phase-E domain extensions are evidence-driven. Before changing a typed engineering surface, review the relevant official vendor manual/specification, vendor-maintained repository/release notes, and upstream tool documentation. Record the concrete decision the source justifies; do not copy implementation complexity that does not improve the RWMCP control-plane contract. Community posts/issues may be used to discover edge cases, but safety, protocol and CLI semantics must be anchored in authoritative sources where available.

For STM32 E1, the initial source set is ST UM1718 (STM32CubeMX project/.ioc behavior), ST-maintained STM32Cube firmware repositories and release notes, OpenOCD's ST-LINK adapter documentation, Arm CMSIS upstream releases, and Keil µVision command-line documentation. This review confirms the current fail-closed single-.ioc selection, retaining firmware-package identity from project metadata, use of the modern `interface/stlink.cfg` path rather than deprecated HLA, and typed Keil `-b`/`-t`/`-o` batch semantics.

## Owner-approved Ubuntu host reboot

`node_reboot_request` is a control-plane action, not a generic engineering shell. On Linux it creates a pending request fixed to `/usr/bin/systemctl --no-block reboot`. The managed MCP service never runs sudo. The owner must open the local TUI, review the requester/reason/exact command, choose **Allow once**, pass a second reboot confirmation, and then let sudo interact directly with the terminal. Active Work Session workflow interlocks block approval. Other Linux admin requests may be denied in TUI but cannot be elevated there.

`Restart runtime` is intentionally separate: it only restarts the managed RWMCP service/tunnel runtime and does not reload the Ubuntu kernel or NVIDIA modules.

## Tool families

- `engineering_*`: inspect a project, create/load `.rwmcp/project.yaml`, list/plan/run approved high-level workflows.
- `hardware_*`: discover serial ports/debug probes and inspect exclusive resource leases. Stable serial selectors may bind project profiles to device ID, USB serial number, or VID/PID plus optional manufacturer/name filters instead of a transient COM/tty path.
- `serial_*`: caller-owned bounded serial monitoring, readiness-marker waiting and policy-gated writes. Low-level `serial_open` still accepts an explicit current OS path; high-level workflows resolve stable project selectors on every run and fail closed on missing/ambiguous matches.
- `terminal_*`: true PTY/ConPTY sessions with bounded I/O. v0.14.4 isolates native `node-pty` in a per-session worker subprocess so a native ConPTY leak/crash cannot take down the MCP host.
- `firmware_*` / `target_reset`: inspect, build, plan, flash, independently verify and reset firmware through constrained providers.
- `debug_*` / `fault_decode`: OpenOCD + GDB/MI debugging, Cortex-M register/memory/fault inspection.
- `ros2_*`: typed colcon build plus bounded node/topic/QoS/service/action/parameter/bag operations.
- `canopen_*`: Phase 3 keeps project-scoped `.eds`/`.dcf` Object Dictionary inspection, configured COB-ID semantics and passive protocol decoding, then adds one reusable capture-analysis surface for node inventory/NMT transitions, initiate-level SDO correlation, EMCY evidence and PDO/SYNC/Heartbeat cadence/jitter/gap statistics. The analysis engine is transport-agnostic and contains no vendor/project-specific device logic. With an explicit node ID or bounded DCF commissioning NodeID, strict `$NODEID`, `$NODEID+literal` and `$NODEID-literal` forms may be resolved; arbitrary expressions remain raw. Observed gaps are evidence only and are not labeled timeouts without explicit configured timeout data. No frames are transmitted or bus state changed.
- `container_*` / `image_build`: typed Docker lifecycle, logs, exec and build operations with a dedicated container policy. Inspection classifies privileged/host namespaces, Docker socket, host-root/sensitive mounts, device passthrough, root user and daemon/context risk before mutation.

## High-level workflow catalog

### Firmware artifact integrity

- `firmware.artifact_prepare`
- `firmware.artifact_accept`

`firmware.artifact_prepare` resolves one project-relative ELF/AXF/HEX/BIN file, hashes it and returns a canonical SHA-256/size manifest without modifying the file. `firmware.artifact_accept` re-hashes staged bytes at the destination, blocks on SHA-256 or size mismatch, then stream-copies to a temporary file and atomically renames only verified content into `.rwmcp/artifacts/verified/<sha256>-<name>`.

The older firmware-specific peer-transfer workflow IDs are intentionally not advertised from v0.14.3 onward. Keeping a second transport path would bypass the single generic cross-node authorization boundary. Cross-node firmware bytes therefore use `platform.transfer_*` or `platform.relay_*`, while firmware integrity remains a separate domain concern.

### STM32

- `stm32_ioc_inspect` (read-only CubeMX metadata)
- `firmware.build`
- `firmware.build_flash`
- `firmware.build_flash_verify`
- `stm32.debug_fault_snapshot`
- `stm32.deep_diagnostics`
- `stm32.peripheral_snapshot`
- `stm32.deploy_accept`
- `stm32.deploy_accept_diagnose`

`stm32_ioc_inspect` reads one project-root `.ioc` file without launching CubeMX or project code. It returns bounded typed evidence for MCU/family/package/part number, project/toolchain metadata, RCC frequency values, CubeMX-declared pins/signals/labels and enabled peripherals with bounded `IPParameters`. Multiple `.ioc` files require explicit `iocFile`; oversized files and workspace/path escapes fail closed.

`firmware.build_flash_verify` performs a normal constrained flash transaction and then a separate OpenOCD `verify_image` acceptance pass. `stm32.debug_fault_snapshot` requires an explicit/persisted ST-Link serial and one unambiguous ELF/AXF symbols artifact, opens a loopback-only OpenOCD/GDB-MI session, halts the core, captures Cortex-M fault state and stack frames, then closes the session and releases the probe. `stm32.deep_diagnostics` extends that path into a single goal-level triage workflow: RTOS auto-awareness, registers, fault snapshot, best-effort architectural exception frame, target-provided RTOS task/thread inventory, stack and disassembly are collected under one caller-owned debug session. If the project profile also provides `firmware.svdFile` and `firmware.liveRegisters`, the same halted session collects safe semantic peripheral snapshots as optional evidence. `stm32.peripheral_snapshot` exposes that SVD-driven path as a focused workflow: semantic peripheral/register selectors are resolved inside the project SVD, then fail-closed checks reject unresolved inheritance, array ambiguity, non-readable access, unsupported widths, truncated/invalid field metadata and register/field `readAction` side effects before any target memory read. Only SVD-derived addresses reach the existing bounded GDB/MI `-data-read-memory-bytes` implementation; raw caller addresses and write operations are not accepted. Optional evidence is marked degraded instead of hiding valid primary evidence, and the probe is released in `finally`.

`stm32.deploy_accept` is the daily-driver deployment path: it performs provider/hardware/serial preflight and then actively proves the selected ST-Link can be opened through a bounded adapter-only OpenOCD SWD check before build. This access check takes a short exclusive probe lease, uses the configured adapter speed, may report target voltage, and releases the lease immediately afterward; it enables bounded OpenOCD debug output so external ownership can be classified reliably, but it does not load a target config or issue reset, halt, or program commands. External ownership is classified as `probe-busy`, while permission and not-found failures remain distinct. Only after preflight succeeds does the workflow build the selected variant, open serial before reset, and execute flash + independent verify + reset inside one OpenOCD process while one ST-Link lease is held. It waits for the configured readiness marker and closes the serial session in `finally` by default. Any failed provider/probe/serial preflight returns `blocked` before build/flash instead of falling back to shell. `stm32.deploy_accept_diagnose` composes this path with `stm32.deep_diagnostics`: it only opens the debug path after flash/verify/reset succeeded and the serial readiness marker still failed, so diagnostic evidence is tied to the confirmed deployed image. Preflight/build/deploy failures stop without automatic debug, and the serial monitor is always closed before diagnostic takeover.

### ESP-IDF

- `firmware.build`
- `firmware.build_flash`
- `firmware.build_flash_monitor`
- `firmware.build_flash_monitor_expect`

The monitor-expect workflow persists stable serial identity/baud/readiness marker in `.rwmcp/project.yaml` and uses `serial_wait_for_text` internally, eliminating repeated chat polling while keeping output and timeout bounded. Legacy static `port:` remains supported, but new profiles should prefer `portSelector` / `monitor.selector` when the adapter exposes a stable USB identity.

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

The Keil provider generates the batch argv internally. Project profiles cannot contain `UV4.exe`, arbitrary command strings or arbitrary command-line arguments. The compatibility baseline uses `-j0 -b <project> -t<target> -o<log>`. Build output is parsed locally into bounded ARMCC/ArmClang/Keil diagnostics, error/warning counts, toolchain family/version, license evidence, deterministic target/output metadata and expected artifact status. Provider discovery reports license state as `unknown` until bounded build output supplies evidence; executable presence alone is never treated as proof of a valid license.

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

## Industrial Endpoint Profiles Phase 2

Industrial Endpoint Profiles provide reusable owner-local, non-secret descriptors that bind the low-level diagnostic tools to named industrial assets without exposing credentials or adding mutation authority.

The file `industrial-endpoints.json` lives in the platform setup-config directory and supports:

- `modbus-tcp` — explicit host, port, Unit ID and default read address/function metadata;
- `opcua` — explicit `opc.tcp` endpoint and default browse root NodeId;
- `mqtt-topic` — a reference to an existing owner-local MQTT credential profile plus a validated topic filter. Device/product topic conventions stay in profile data, not RWMCP source.

Available tools:

- `industrial_profile_list` — lists bounded non-secret profile metadata without network activity.
- `industrial_profile_inspect` — returns one named profile.
- `industrial_profile_preflight` — performs one bounded read-only readiness check using the existing Modbus RTU/TCP, OPC UA or generic MQTT topic provider.

MQTT passwords remain outside this profile file and outside MCP arguments. Profiles carry endpoint/topic data only; project-specific message meanings remain in project configuration or higher-level workflows. No MQTT publish or industrial write/control action is introduced.

## OPC UA diagnostics Phase 1

OPC UA Phase 1 is cross-platform, anonymous and read-only over one explicit `opc.tcp://host:port/path` endpoint. It uses the official NodeOPCUA client stack and an in-memory certificate/key provider, so it does not create PKI files on the workstation.

Available tools:

- `opcua_provider_status` — reports the SDK/provider boundary and intentionally unavailable mutation surfaces.
- `opcua_endpoint_describe` — returns bounded endpoint, security-mode/policy and user-token metadata without returning server certificate bytes.
- `opcua_browse` — performs one bounded forward Browse from an explicit NodeId; server continuation points are reported but never followed automatically.
- `opcua_read` — reads 1..32 explicit NodeId/attribute pairs and bounds strings, arrays, buffers and nested values before returning them.

Phase 1 fixes the client session to anonymous `SecurityPolicy.None / MessageSecurityMode.None`. Username/password identity, certificate enrollment, Write, Method Call, subscriptions, monitored-item mutation, HistoryUpdate and NodeManagement are intentionally unavailable and belong to separately reviewed future phases.

## Modbus TCP diagnostics Phase 1

Modbus TCP diagnostics are cross-platform and read-only. The caller must provide one explicit host, port and Unit ID; RWMCP does not discover hosts or scan a subnet.

Available tools:

- `modbus_tcp_provider_status` — reports the built-in `node:net` read-only provider and supported functions.
- `modbus_tcp_endpoint_status` — checks bounded TCP reachability for one explicit endpoint without sending a Modbus request.
- `modbus_tcp_read` — performs one FC01/02/03/04 request with MBAP transaction/protocol/length/unit validation and bounded quantities.
- `modbus_tcp_probe` — probes only 1..32 explicit unique Unit IDs supplied by the caller with one bounded read per Unit ID.

Phase 1 intentionally excludes FC05/06/0F/10 and all other write/mutation functions, raw PDU injection, implicit Unit-ID sweeps, subnet scanning and server configuration.

## MQTT diagnostics Phase 2

MQTT diagnostics are subscribe-only and use owner-local profiles instead of accepting broker credentials through MCP arguments. Profiles are stored outside the repository at the platform setup-config directory in `mqtt-profiles.json`.

Example profile file:

```json
{
  "version": 1,
  "profiles": [
    {
      "id": "plant",
      "host": "broker.example.internal",
      "port": 1883,
      "tls": false,
      "username": "operator",
      "passwordEnv": "RWMCP_MQTT_PLANT_PASSWORD"
    }
  ]
}
```

The password value itself is never stored in this file; only the environment-variable name is persisted. TLS profiles always verify the broker certificate.

Available tools:

- `mqtt_provider_status` — reports non-secret profile readiness and the subscribe-only authority boundary.
- `mqtt_subscribe_sample` — collects a bounded MQTT 3.1.1 topic sample and parses bounded UTF-8/JSON evidence.
- `mqtt_json_observe` — subscribes to an explicit topic filter, searches bounded nested JSON objects for a caller-selected property/value, and returns only selected scalar fields plus JSON paths. This replaces unreleased project-specific MQTT helpers.

Phase 2 does not expose PUBLISH, retained-message mutation, broker configuration or credential mutation.

## Camera diagnostics Phase 3

Camera diagnostics use owner-local RTSP profiles in `camera-profiles.json`. RTSP observation remains anonymous-only. Phase 2 optionally adds ONVIF PTZ metadata to a profile; the password value itself stays in an owner-controlled environment variable and is never accepted as an MCP argument.

Example:

```json
{
  "version": 1,
  "profiles": [
    {
      "id": "warehouse-1",
      "label": "Warehouse camera 1",
      "host": "192.168.1.20",
      "port": 554,
      "path": "/Streaming/Channels/101",
      "transport": "tcp",
      "auth": "none",
      "ptz": {
        "scheme": "http",
        "port": 80,
        "path": "/onvif/ptz_service",
        "profileToken": "Profile_1",
        "username": "operator",
        "passwordEnv": "RWMCP_CAMERA_WAREHOUSE_1_PASSWORD"
      }
    }
  ]
}
```

Public profile/list responses redact the PTZ username, password environment-variable name and password value. They expose only whether PTZ is configured and whether the referenced credential is available to the runtime.

Available tools:

- `camera_provider_status` — reports RTSP/ffprobe readiness plus configured/credential-ready ONVIF PTZ counts.
- `camera_profile_list` / `camera_profile_inspect` — inspect redacted owner-local camera metadata.
- `camera_rtsp_probe` — sends one bounded RTSP DESCRIBE and reports reachability, auth requirement and SDP media tracks.
- `camera_stream_metadata` — runs a fixed bounded ffprobe argv for anonymous RTSP profiles.
- `camera_ptz_status` — reads ONVIF PTZ position and move-state evidence.
- `camera_ptz_move` — normalized pan/tilt/zoom in `[-1,1]`, duration 50–2000 ms, followed by an automatic PTZ Stop.
- `camera_ptz_stop` — explicit bounded Stop for pan/tilt and zoom.
- `camera_fleet_probe` — concurrently probes up to 32 configured cameras with bounded concurrency (1–8), returning per-camera health/auth/media evidence plus fleet p50/p95 RTSP latency.

PTZ uses ONVIF WS-Security UsernameToken PasswordDigest; raw SOAP/XML and arbitrary endpoints are not accepted. Phase 3 adds only read-only fleet diagnostics on top of Phase 2 PTZ. Two-way audio, camera configuration and snapshot/output mutation remain unavailable. HTTPS uses normal certificate verification; no insecure TLS bypass is exposed.

## Media and video Phase 1

Media/Video Phase 1 adds typed local media operations without exposing arbitrary FFmpeg command strings or arbitrary ComfyUI workflow injection.

Owner-local ComfyUI endpoints are stored in `media-profiles.json`:

```json
{
  "version": 1,
  "profiles": [
    {
      "id": "gpu",
      "kind": "comfyui",
      "host": "127.0.0.1",
      "port": 8188,
      "scheme": "http"
    }
  ]
}
```

Available tools:

- `media_provider_status` — reports FFmpeg/FFprobe availability, Remotion launcher readiness and configured ComfyUI profiles.
- `media_file_probe` — project-scoped FFprobe inspection with bounded metadata output.
- `media_transcode_plan` — validates one fixed-preset MP4 transcode without executing FFmpeg.
- `media_transcode` — Work Session-owned fixed-preset FFmpeg MP4 transcode with fail-if-exists, partial-output cleanup and SHA-256 evidence.
- `media_remotion_status` — inspects project-local Remotion packages and render-oriented scripts without invoking npm/npx.
- `media_comfyui_status` — read-only `/system_stats` and `/queue` health observation.

Phase 1 does not accept raw FFmpeg arguments, arbitrary output formats, implicit overwrite, arbitrary ComfyUI workflow submission/model download, or arbitrary process execution.

### ComfyUI preset jobs (Phase 2)

Phase 2 allows queue submission only through owner-local presets declared in `comfyui-presets.json` and workflow API JSON files under `comfyui-workflows/`. MCP never accepts raw workflow JSON.

Example manifest:

```json
{
  "version": 1,
  "presets": [
    {
      "id": "image-basic",
      "profileId": "gpu",
      "workflowFile": "image-basic.json",
      "bindings": {
        "prompt": {
          "type": "string",
          "nodeId": "6",
          "input": "text",
          "required": true,
          "maxLength": 2000
        },
        "seed": {
          "type": "number",
          "nodeId": "3",
          "input": "seed",
          "default": 7,
          "min": 0,
          "max": 4294967295
        }
      }
    }
  ]
}
```

Available Phase 2 tools:

- `media_comfyui_preset_list` — exposes only preset IDs, labels, provider IDs and public typed binding metadata.
- `media_comfyui_job_plan` — validates workflow existence plus typed overrides without queue mutation.
- `media_comfyui_job_submit` — Work Session-owned POST to `/prompt` using only the owner-local preset and whitelisted scalar bindings.
- `media_comfyui_job_status` — reads bounded `/history/<promptId>` status and artifact metadata without returning raw workflow/history payloads.

Arbitrary workflow JSON, custom node configuration through MCP, model download and queue cancellation remain unavailable in this phase.

### ComfyUI artifact handoff (Phase 3)

Phase 3 can import a completed durable ComfyUI `output` artifact into an owned project without accepting source filenames or subfolders as MCP input.

- `media_comfyui_artifact_plan` resolves one artifact strictly by `profileId + promptId + artifactIndex`, validates history metadata and destination containment, and performs no file mutation.
- `media_comfyui_artifact_import` requires Work Session ownership, downloads the selected `output` artifact through ComfyUI `/view`, streams with a bounded byte limit, writes to a temporary sibling file, then atomically renames and returns SHA-256 evidence.
- destination files are fail-if-exists and must keep the source media extension;
- traversal, unsupported extensions, `temp`/non-durable artifacts, redirects and partial files fail closed.

Raw provider paths, arbitrary `/view` query parameters and implicit overwrite remain unavailable.

### Remotion typed render (Phase 4)

Phase 4 promotes Remotion from package inspection to a typed render workflow. Presets are owner-local in `remotion-presets.json`; MCP callers select only a preset ID, whitelisted scalar props and a project-relative `.mp4` output.

- `media_remotion_preset_list` exposes preset IDs, labels, composition/encoder settings and public binding metadata without returning entry-point filesystem paths;
- `media_remotion_render_plan` validates the owner preset, entry point, local project Remotion CLI, local Chrome/Chromium availability and fail-if-exists destination without rendering;
- `media_remotion_render` requires Work Session ownership, uses fixed H.264 arguments plus bounded preset settings, stores temporary props outside the project tree, removes partial output on failure and returns size + SHA-256 evidence on success;
- RWMCP never accepts raw Remotion flags, arbitrary entry points/composition IDs, shell commands or browser-download requests through MCP.

Example owner-local preset manifest:

```json
{
  "version": 1,
  "presets": [
    {
      "id": "lesson-vertical",
      "entryPoint": "src/remotion/index.ts",
      "compositionId": "LessonVertical",
      "crf": 20,
      "concurrency": 4,
      "x264Preset": "medium",
      "bindings": {
        "title": { "type": "string", "required": true, "maxLength": 200 },
        "lesson": { "type": "number", "min": 1, "max": 100 }
      }
    }
  ]
}
```

### Media end-to-end engineering workflows (Phase 5)

Phase 5 connects the existing Media extension to the generic Engineering Workflow envelope instead of adding more top-level MCP actions. Extension-owned workflow contributions are registered behind the same `engineering_workflow_list`, `engineering_workflow_plan` and `engineering_workflow_run` contract used by core engineering domains.

- `media.remotion.render_accept` validates an owner-local Remotion preset, renders one fail-if-exists MP4, then requires FFprobe acceptance evidence before success.
- `media.comfyui.generate_import_accept` validates an owner-local ComfyUI preset, submits it, bounded-polls completion, atomically imports one durable output artifact, then requires FFprobe acceptance evidence.
- mutating extension workflows require an explicit Work Session even when invoked through the generic workflow envelope.
- contribution IDs cannot shadow built-in workflow IDs; duplicate and malformed registrations fail closed.
- ComfyUI waiting is finite and never implies remote queue cancellation. A completion timeout returns the durable prompt ID as recovery evidence.
- acceptance failure preserves the already-created artifact evidence for diagnosis rather than silently deleting a completed render/import.

The contribution seam is domain-neutral so later Camera, CANopen, OPC UA or other extensions can add compound workflows without growing `EngineeringWorkflowEngine` into another domain monolith.

## Safety model

Engineering tools do not bypass RWMCP policy. Read-only discovery/inspection remains separate from execution and hardware mutation. Workspace/project containment, explicit probe/port identity, exclusive leases, bounded input/output/runtime and authenticated MCP scopes apply before provider execution.

Project manifests are data-only. They cannot contain executable paths, shell commands, arbitrary OpenOCD TCL, arbitrary GDB commands, arbitrary colcon arguments, STM32 Option Byte/RDP operations, ESP eFuse writes, target memory writes or mass-erase recipes.

## Why typed workflows

The stable semantic contract lets ChatGPT ask for intent such as “build, flash, verify” or “build ROS workspace and check graph health” instead of rebuilding a shell recipe in every conversation. Provider implementation can evolve internally without changing the project-level workflow contract.

Starting with action schema v2, `engineering_workflow_plan` and `engineering_workflow_run` accept a bounded semantic workflow ID plus a server-validated `parameters` object. `engineering_profile_init` also accepts a versioned server-validated `profile` object. This keeps the ChatGPT action surface stable while providers/workflow IDs evolve; only an `actionSchemaVersion` bump requires the custom-app action catalog to be refreshed.

v0.13 proves this contract for engineering growth. v0.14.0 reuses the same generic workflow + `parameters` envelope for core `platform.transfer_*` workflow IDs, so `actionSchemaVersion` remains `2` and `engineeringApiVersion` remains `3` without adding a new top-level ChatGPT action.
