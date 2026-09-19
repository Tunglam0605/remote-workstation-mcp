# Remote Workstation MCP

**Install once on each workstation. Connect each node directly to ChatGPT. No SSH hub required.**

Remote Workstation MCP (RWMCP) securely connects ChatGPT to Windows and Linux engineering workstations. Each machine can run as an independent Direct Node with its own outbound OpenAI Secure MCP Tunnel. The local owner decides what ChatGPT may read, modify, or execute, while the workstation MCP itself stays bound to loopback instead of being exposed directly to the Internet.

## Project direction

The authoritative product-direction document is [`docs/PROJECT_CHARTER.md`](docs/PROJECT_CHARTER.md). It defines the mission, North Star, platform/extension boundary, architectural invariants and feature decision gate.

**Release notes describe implementation history; they do not redefine the product mission.** Domain-specific workloads such as STM32, ESP32 and ROS 2 are extensions and acceptance workloads on top of the generic workstation platform.

## Current release

**v0.14.3**

v0.14.3 hardens Direct Multi-Node around a strict security invariant: **ChatGPT controls nodes; nodes do not control one another.**

- cross-node data movement is default-deny;
- a transfer requires the owner-approved OpenAI Secure MCP Tunnel principal plus the dedicated `workstation.cross_node_transfer` scope;
- source and destination independently require the same directional grant, so permission on one laptop is never enough to read another node;
- grants bind source/destination node IDs, workspaces, source path prefixes, destination base paths, file extensions, maximum size and allowed direct/relay transports;
- Direct HTTP tickets are cryptographically random but are now also bound to the exact authorization contract, so a valid ticket cannot be reused for another node/workspace/file contract;
- relay sessions persist the authorization binding and re-check the destination grant on status/write/finalize/abort, making revocation effective during resumable transfers;
- Full Access does **not** imply cross-node authority;
- legacy workstation-to-workstation SSH/device execution is locally disabled by default;
- legacy `firmware.artifact_receive_offer` / `firmware.artifact_push` are no longer exposed in the workflow catalog; firmware bytes use the secured generic platform data plane;
- authorization allow/deny decisions receive dedicated security audit entries;
- Action Schema v2 and Engineering API v3 remain unchanged; no ChatGPT action refresh is required.

Existing installations that do not add `multiNode` grants become safer after upgrade: local engineering work continues, while cross-node transfer remains denied until the owner explicitly configures matching grants on both participating nodes.

**v0.14.2**

v0.14.2 closes the second real multi-node acceptance gap: healthy Direct Nodes can each be reachable from ChatGPT while still having **no mutual peer route** over Tailscale, private LAN or an existing WireGuard overlay.

- keep direct transfer as the preferred fast path up to 512 MiB;
- add a bounded **control-plane relay fallback** for files up to 32 MiB when no direct node-to-node path exists;
- add `platform.relay_read_chunk`, `platform.relay_begin`, `platform.relay_status`, `platform.relay_write_chunk`, `platform.relay_finalize`, and `platform.relay_abort` through the existing stable workflow envelope;
- relay at most 64 KiB per chunk with exact sequential offsets and SHA-256 per chunk;
- persist relay session state under `.rwmcp/transfers/relay/<session-id>/` so orchestration can resume after interruption;
- verify full-file SHA-256/size again before atomically promoting into the generic verified store;
- expose relay support/limits in `chatgpt_web_status.nodeHealth.dataPlane.controlPlaneRelay`;
- keep payload content out of workflow plans and recommended chat output; orchestration should pipe nested tool results directly from source read to destination write;
- preserve `actionSchemaVersion=2` and `engineeringApiVersion=3`; no ChatGPT action refresh is required.

The relay is intentionally bounded and secondary. It uses the already-authenticated MCP control paths only when no direct peer route exists.

**v0.14.1**

v0.14.1 fixes the first real multi-node acceptance gap found in v0.14.0:

- receiver offers can bind multiple approved direct IPv4 candidates instead of assuming one Tailscale address is mutually reachable;
- production candidates include Tailscale and RFC1918 private-LAN interfaces, while Docker/bridge/common tunnel interfaces are filtered from automatic private-LAN discovery;
- `platform.transfer_receive_offer` returns a bounded `endpoints[]` list plus the legacy first `endpoint`;
- `platform.transfer_push` accepts `transferEndpoints[]` and automatically falls back across network-unreachable candidates while preserving one SHA/size/ticket contract;
- HTTP rejection such as invalid ticket still fails closed and is not bypassed by trying another endpoint;
- `nodeHealth` now reports direct/private-LAN/Tailscale availability separately and only degrades when no approved direct IPv4 candidate exists;
- keep normal MCP loopback-only, one-shot tickets, bounded TTL, content-addressed acceptance and Action Schema v2 / Engineering API v3.

Real acceptance on v0.14.0 showed Windows and Ubuntu Vision had valid Tailscale IPs but belonged to different Tailscale peer graphs, so Tailscale-only reachability was an invalid platform assumption.

**v0.14.0**

v0.14.0 begins the platform-first multi-node milestone defined by the project charter:

- add a core `DataPlaneAdapter` outside the engineering domain for generic workspace files, not only firmware artifacts;
- add `platform.transfer_prepare`, `platform.transfer_receive_offer`, and `platform.transfer_push` through the existing stable workflow envelope;
- stream up to 512 MiB directly Direct-Node -> Direct-Node over the owner's encrypted Tailscale mesh instead of routing payload bytes through ChatGPT;
- verify SHA-256 and size before sending, while receiving, and again during atomic promotion into `.rwmcp/transfers/verified/`;
- expose non-secret data-plane availability, active offers, recent transfer results, runtime uptime, memory and active-session counts through `chatgpt_web_status.nodeHealth`;
- keep the normal MCP runtime loopback-only, keep one-shot 256-bit transfer tickets out of plans/status, and preserve independent Direct Node security boundaries;
- keep existing `firmware.artifact_*` workflows for compatibility while treating them as domain-extension APIs;
- preserve `actionSchemaVersion=2` and `engineeringApiVersion=3`; **no ChatGPT action refresh is required** for an app already on schema v2.

See [`docs/DATA_PLANE.md`](docs/DATA_PLANE.md) and [`docs/MULTI_DEVICE.md`](docs/MULTI_DEVICE.md).

**v0.13.6**

v0.13.6 adds native Direct-Node firmware artifact transfer over the owner's encrypted Tailscale mesh while preserving the trusted artifact boundary:

- add `firmware.artifact_receive_offer` to open a short-lived one-shot receiver bound only to a local Tailscale IPv4 address;
- add `firmware.artifact_push` to stream ELF/AXF/HEX/BIN bytes directly from the source Direct Node to the destination Direct Node without routing payload bytes through ChatGPT;
- authenticate each receive offer with a random 256-bit bearer ticket bound to one artifact name, exact SHA-256, exact size and bounded TTL;
- verify Content-Length and declared digest before streaming, hash again while receiving, and reuse v0.13.5 atomic destination acceptance before returning success;
- automatically remove incoming staging files and close the listener after success or expiry;
- restrict production peer endpoints to Tailscale CGNAT IPv4 addresses (`100.64.0.0/10`); loopback is test-only;
- never include the transfer ticket in workflow plans; it is returned only by the receive-offer run and must be treated as an ephemeral secret;
- keep `actionSchemaVersion=2` and `engineeringApiVersion=3`; transfer fields stay inside the existing generic workflow `parameters` envelope.

**v0.13.5**

v0.13.5 adds a transport-agnostic trusted artifact integrity layer to the existing Engineering Workflow Engine:

- add `firmware.artifact_prepare` to hash an ELF/AXF/HEX/BIN artifact and return a canonical SHA-256/size manifest without building or mutating hardware;
- add `firmware.artifact_accept` to fail closed on SHA-256/size mismatch, stream-copy the staged file while hashing, and atomically promote only verified bytes into `.rwmcp/artifacts/verified/`;
- keep transport separate from trust: Direct Node orchestration, SSH/SFTP, HTTP object storage or a future provider may move bytes, while acceptance always re-hashes at the destination;
- make acceptance idempotent for an already verified content-addressed artifact and persist a local verification manifest;
- preserve `actionSchemaVersion=2` and `engineeringApiVersion=3`; the workflows use the existing generic `parameters` envelope, so no ChatGPT custom-app action refresh is required.

**v0.13.4**

v0.13.4 closes the real-hardware ST-Link ownership-classification gap found during v0.13.3 acceptance:

- run only the adapter-only active preflight with OpenOCD debug level 3 so xPack OpenOCD emits the otherwise-hidden `claim interface failed` evidence when another process owns the ST-Link;
- keep the preflight target-free: no target config, reset, halt, flash or program operation is added;
- preserve the existing `probe-busy` classifier and stable hardware resource ID; the change only makes backend evidence observable;
- add regression coverage that fails unless the active preflight actually requests `-d3`;
- keep `actionSchemaVersion=2` and `engineeringApiVersion=3`; no ChatGPT custom-app action refresh is required.

**v0.13.3**

v0.13.3 hardens STM32 deployment preflight so a connected ST-Link is proven usable before any build or mutation starts:

- actively open the selected ST-Link through a bounded adapter-only OpenOCD SWD preflight before build;
- hold a short exclusive probe lease during that access check, then always release it before the workflow continues;
- do not load a target config and do not issue reset, halt or program commands during active preflight;
- report target voltage when OpenOCD exposes it and honor the configured/overridden SWD adapter speed;
- classify external probe ownership as `probe-busy`, distinguish permission/not-found failures, and block `stm32.deploy_accept` before build on any failed access check;
- normalize the lease resource ID to the stable discovered hardware ID when an ST-Link has no usable serial number;
- keep `actionSchemaVersion=2` and `engineeringApiVersion=3`; no ChatGPT custom-app action refresh is required.

v0.13.2 removes the remaining per-chat OpenOCD setup on Windows STM32 workstations:

- auto-discover STM32CubeIDE bundled OpenOCD from owner-configured roots, `C:\ST\STM32CubeIDE_*` and common STMicroelectronics install locations when `openocd` is not on PATH;
- resolve STM32CubeIDE's separate `st_scripts` debug-plugin directory and pass it through `-s <path>` for flash, verify, reset, transactional deploy and debug sessions;
- keep explicit owner overrides first-class through absolute `RWMCP_OPENOCD_EXECUTABLE` and optional `RWMCP_OPENOCD_SCRIPTS` paths;
- expose the resolved script search path in typed provider status/flash plans so diagnostics are deterministic instead of relying on process cwd;
- regression-test CubeIDE discovery, absolute scripts overrides and script-path propagation through the single-lease/single-process STM32 deploy transaction;
- keep `actionSchemaVersion=2` and `engineeringApiVersion=3`; no ChatGPT custom-app action refresh is required.

v0.13.1 hardens the Windows recovery plane after real production acceptance of the v0.13.0 minor upgrade:

- after every managed slot switch, Boot auto-update, manual Update and Rollback now re-home the Control Center and autonomous recovery worker to the active `current` slot before the lifecycle is considered successful;
- `Start-RecoveryControlCenter` now verifies `running`, `healthy`, managed ownership of the Control Center port, and exact root equality instead of trusting only a child exit code;
- candidate activation failure re-homes the recovery plane again after rollback, including owner-stop-preserved paths;
- add a Windows integration test that starts a fake Control Center in slot A, re-homes it to slot B, verifies the old host exits, HTTP stays healthy and the recovery worker reports the slot-B root;
- keep `actionSchemaVersion=2` and `engineeringApiVersion=3`; no ChatGPT custom-app action refresh is required from v0.13.0.

v0.13.0 adds the first daily-driver STM32 deployment workflow while preserving the stable ChatGPT Action Schema v2:

- add `stm32.deploy_accept`: read-only hardware/provider preflight -> build -> serial open -> atomic OpenOCD flash/independent verify/reset -> readiness-marker acceptance -> automatic serial cleanup;
- keep flash/verify/reset inside one ST-Link lease and one OpenOCD process to avoid cross-step probe races;
- fail closed with structured `blocked` status before build when OpenOCD, ST-Link, or the configured monitor port is unavailable;
- open serial before target reset so early boot/readiness output is not missed;
- close/release serial in `finally` by default on success, deployment failure, or readiness timeout; `parameters.keepMonitorOpen=true` is an explicit opt-in for follow-up diagnostics;
- freeze the legacy `overrides` action schema and validate new workflow parameters only inside the generic `parameters` envelope, so `actionSchemaVersion` remains **2** while `engineeringApiVersion` advances to **3**;
- add provider-level regression coverage proving exactly one OpenOCD invocation runs while exactly one ST-Link lease is held for the transaction.

v0.12.0 makes the Engineering Workflow Engine practical for real multi-target Keil/STM32 projects and stabilizes the ChatGPT action surface:

- detect Keil MDK `.uvprojx` projects, target names, STM32 devices, output directories and expected AXF artifacts without executing project code;
- add a constrained Windows Keil µVision batch-build provider with owner/PATH/known-install discovery and no arbitrary command-line surface;
- add project-profile firmware variants so one repository can safely represent F407/H743/hardware-test targets without guessing the active board;
- keep `engineering_workflow_plan/run` action schemas stable through a string workflow ID plus server-validated `parameters`, and allow a versioned generic `profile` payload for profile initialization;
- expose `actionSchemaVersion=2` and `engineeringApiVersion=2` so operators can distinguish an app-catalog refresh from normal provider/workflow growth;
- validate the Keil provider on the real B300 F407 target with µVision 5.31: typed adapter build, exit 0, zero errors/warnings. H743 provider execution also reached the real compiler and surfaced the project-level missing `Task_IPC.h` dependency rather than masking it.

v0.11.0 deepens the Engineering Workflow Engine so repeated embedded/ROS work can collapse into one typed MCP call:

- add `firmware.build_flash_verify` for STM32 build -> flash -> independent OpenOCD verify acceptance;
- add `stm32.debug_fault_snapshot` for ELF/AXF selection -> debug session -> halt -> Cortex-M fault decode -> stack capture -> automatic probe release;
- add `firmware.build_flash_monitor_expect` plus `serial_wait_for_text` so ESP-IDF flashing can wait for a persisted boot/readiness marker without chat-side polling;
- add typed `ros2_build`/`ros2.build` and `ros2.build_health` using bounded colcon options from `.rwmcp/project.yaml`;
- add `ros2_topic_info` for verbose endpoint/QoS inspection while keeping arbitrary shell/colcon/OpenOCD/GDB commands unavailable.

v0.10.2 closes the recovery-plane convergence gap found during the next real-machine acceptance:

- autonomous recovery now reads managed `current.txt` and self-terminates before heartbeat/evaluation when its slot is no longer current;
- the Control Center converges managed recovery workers before every recovery spawn, removing stale other-slot and duplicate current-slot workers;
- the shared Windows convergence helper now owns recovery-plane cleanup with the same managed-process ownership checks used for runtime cleanup;
- successful updates clear historical `failedVersion`, `failedAt`, and `retryAfter` metadata so stale failure state cannot pollute later healthy releases;
- regression tests cover old-slot self-exit, duplicate recovery convergence, and watchdog behavior.

v0.10.1 closes the Windows Control Center update-handoff failure found during real-machine acceptance:

- replace Node `spawn(... detached: true)` for update workers with a short-lived PowerShell starter that creates the durable worker through `Win32_Process.Create`/CIM outside the managed RWMCP process tree;
- require a real `RUNNING`/`SUCCEEDED` startup acknowledgement before the Control Center returns HTTP 202, eliminating false-positive accepted updates;
- mark abandoned unacknowledged `STARTING` transactions stale after a short startup grace instead of blocking updates for 15 minutes;
- add Windows regression coverage for the real CIM parent boundary, successful handoff, and a worker that exits before acknowledgement.

v0.10.0 introduces the Engineering Workflow Engine for recurring ChatGPT Web engineering work:

- add project-local `.rwmcp/project.yaml` profiles for persistent firmware/ROS 2 defaults across chats;
- add `engineering_project_inspect`, profile initialization and workflow list/plan/run tools;
- add typed `firmware.build`, `firmware.build_flash`, and `firmware.build_flash_monitor` compound workflows with fail-fast behavior;
- add profile-driven ROS 2 environment bootstrap and one-call `ros2.health`;
- preserve typed providers, hardware leases, workspace containment, authenticated scopes and audit instead of accepting arbitrary shell recipes.

v0.9.11 closes the Windows update/convergence failures found during real-machine acceptance:

- runtime startup now converges stale, duplicate, cross-slot, and orphan managed MCP/tunnel processes before the candidate slot binds port 8683;
- the full Windows start path, including Control Center startup, is serialized by the cross-process runtime-start lock so concurrent starts cannot create duplicate recovery/control planes;
- manual update fails closed when the active runtime cannot be stopped safely instead of switching version slots and racing the old runtime;
- Windows update transactions persist `STARTING` before worker launch so a completed transaction cannot be overwritten back to stale `STARTING`; v0.10.1 later replaces the fragile Node detached-spawn boundary with CIM-backed durable worker creation;
- CI now reproduces cross-slot cleanup, orphan MCP/tunnel cleanup, concurrent startup, lifecycle interlocks, and all durable update-handoff success/failure modes.

v0.9.10 adds persisted lifecycle epochs, ownership-safe convergence, a bounded recovery circuit breaker, and SHA-verified GitHub API release-asset fallback. Together with the v0.9.9 cross-process runtime-start lock, Windows recovery now converges toward exactly one managed runtime/tunnel stack while planned lifecycle transactions suppress recovery races.

v0.9.9 hardens the autonomous Windows recovery path against concurrent runtime starts. A cross-process file lock serializes Boot, Update, Restart, StartOpenAI, and recovery startup so only one supervisor can bind the MCP port at a time. v0.9.8 added the autonomous Windows recovery supervisor and heartbeat watchdog:

- persist owner desired state outside version slots; explicit Stop remains stopped across recovery and reboot paths;
- planned boot/update/rollback/restart use bounded maintenance windows instead of racing the watchdog;
- the persistent Control Center host supervises both the WebUI child and an autonomous runtime-recovery child;
- missing runtime supervisor triggers stable `StartOpenAI`, while sustained MCP/tunnel health failures trigger the durable Restart handoff;
- recovery retries use bounded 2/4/8/15/30/60 second backoff and never require SSH as part of the normal path;
- Windows CI validates desired-state persistence, owner-stop suppression and missing-runtime recovery before release.

v0.9.4 hardens the Windows Control Center as the always-on local recovery plane:

- Boot starts the loopback Control Center before automatic updates or MCP/tunnel activation;
- recovery root selection falls back to the previous installed slot when the current slot is unusable;
- manual update and rollback ensure the Control Center is alive before stopping the managed runtime;
- the Control Center host now watchdog-restarts a crashed WebUI child with bounded 1/2/5/10/30 second backoff;
- Windows CI kills the WebUI child and verifies a replacement process restores HTTP health.

v0.9.3 hardens the STM32/OpenOCD provider contract without opening new dangerous debug surfaces:

- add `firmware_provider_status` for OpenOCD availability/version/capability preflight;
- allow an owner-controlled absolute `RWMCP_OPENOCD_EXECUTABLE` override so RWMCP can reuse pinned xPack/ST OpenOCD backends such as those used by B300 tooling without accepting executable paths from AI tool calls;
- add bounded `adapterSpeedKhz` (50..24000 kHz) to STM32 flash/verify/reset and debug-session startup;
- classify common OpenOCD failures into actionable codes such as probe missing/permission denied, target power/connect failure, verify failure, timeout and config missing;
- keep arbitrary TCL, mass erase, Option Bytes, readout-protection changes, memory write and GDB flash unavailable;
- CI/provider simulation is accepted on Windows/Linux; real ST-Link target acceptance remains a separate hardware gate because the current Ubuntu nodes have no probe attached.

v0.9.2 makes Windows managed updates durable across the runtime/tunnel restart boundary:

- Control Center hands an owner-approved install to a detached update worker instead of awaiting the update inside the MCP runtime request path;
- the worker persists `STARTING / RUNNING / SUCCEEDED / FAILED` transaction state and a local update log outside version slots;
- failed activation performs a best-effort `StartOpenAI` recovery on the current/rolled-back slot;
- OpenAI activation now allows 180 seconds while the supervisor may recycle an unhealthy first tunnel child after 60 seconds;
- Windows CI simulates both successful slot activation and failed-update recovery through the real PowerShell handoff script.

v0.9.1 hardens Windows post-update tunnel recovery:

- tunnel readiness now requires a recent successful OpenAI control-plane poll, not only local `/readyz`;
- the Windows watchdog detects stale control-plane polling and automatically recycles the managed tunnel runtime with bounded backoff;
- runtime start/update health gates wait for a fresh poll before declaring the Direct Node online;
- Windows CI validates the Prometheus poll metric parser and the new recovery contract.

v0.9.0 introduces the first typed engineering-tool layer for Remote Workstation MCP:

- true PTY/ConPTY sessions and bounded serial I/O;
- hardware discovery plus exclusive ST-Link/serial resource leases;
- typed firmware project inspection, build, flash-plan, flash, verify and reset workflows;
- constrained OpenOCD + GDB/MI debugging with stack/register/variable/breakpoint/memory-read/fault diagnostics;
- ESP-IDF provider activation, ROS 2 typed workflows and Docker/container typed workflows;
- project/workspace containment, authenticated scope classification and separate hardware-mutation/serial-write policy gates;
- pinned native dependencies and packed-artifact smoke coverage for managed installs.

Raw shell remains an explicitly elevated escape hatch. v0.9.0 intentionally does not expose mass erase, STM32 Option Bytes, ESP eFuse writes, arbitrary OpenOCD/GDB commands, target memory writes or GDB flashing.

See `docs/ENGINEERING_TOOLS.md` for the tool families and safety model.

## Engineering project profiles and workflows

RWMCP's next layer is designed for recurring engineering work: project facts are discovered once, persisted as data, and reused by every ChatGPT Web conversation.

A project may keep a versioned `.rwmcp/project.yaml` manifest. The manifest stores defaults such as build provider, build directory, probe/serial identity, monitor baud rate, ROS 2 distro/workspace setup and `ROS_DOMAIN_ID`. It does **not** contain arbitrary shell commands.

High-level tools:

- `engineering_project_inspect` — one read-only call for detected project type, artifacts, hardware, profile and available workflows;
- `engineering_profile_init` — create the canonical `.rwmcp/project.yaml` from detection plus owner/project defaults;
- `engineering_workflow_list` — discover supported semantic workflows for the selected project;
- `engineering_workflow_plan` — resolve defaults/steps before execution;
- `engineering_workflow_run` — execute the approved typed workflow and return per-step structured results.

Built-in workflows now include `firmware.build`, `firmware.build_flash`, `firmware.build_flash_verify`, `firmware.build_flash_monitor`, `firmware.build_flash_monitor_expect`, `stm32.debug_fault_snapshot`, `stm32.deploy_accept`, `ros2.build`, `ros2.health`, and `ros2.build_health`.

Since v0.12, the high-level ChatGPT action contract is intentionally stable: `workflow` is a bounded semantic string and workflow-specific values travel inside a server-validated `parameters` object. New workflow IDs/providers can therefore be added without changing the top-level action schema. When `actionSchemaVersion` itself changes, refresh the custom-app actions once; ordinary runtime updates with the same schema version do not require a new app/tool catalog.

Example Keil multi-target STM32 profile:

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

For a multi-target Keil project without `defaultVariant`, planning/building fails closed until a variant is selected, for example `parameters.variant = "main-v3-h743"`.

Example ESP-IDF profile:

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

Example ROS 2 profile:

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
    packagesSelect: [robot_bringup, robot_control]
```

The ROS 2 workflow performs the distro/workspace environment bootstrap internally, so each new chat does not need to rediscover and repeat `source /opt/ros/.../setup.bash`, `source install/setup.bash`, and `export ROS_DOMAIN_ID=...` before normal graph inspection.

See `docs/ENGINEERING_WORKFLOW_BENCHMARK.md` for the GitHub benchmark and architectural rationale.

## Recover an expired/revoked key or changed tunnel

The local Control Center is intentionally independent from the OpenAI tunnel. Even when ChatGPT cannot reach the workstation, open locally:

```text
http://127.0.0.1:8684
```

Then open **Settings -> OpenAI connection**:

1. replace the Tunnel ID only if it actually changed;
2. paste a new restricted Runtime API key with **Tunnels Read + Use**;
3. choose **Test credentials**;
4. when verification succeeds, choose **Save & reconnect**.

The saved key is protected with current-user Windows DPAPI and is never read back into the browser. A failed or unavailable MCP runtime is shown as `OFFLINE`/`RECOVERY`; it must not prevent the local Control Center from loading.

## New user path: from zero to READY

A first-time user only needs to complete this flow once:

```text
Download installer
      -> install RWMCP
      -> create OpenAI Secure MCP Tunnel
      -> create restricted Runtime API key
      -> enter Tunnel ID + Organization ID + API key in Control Center
      -> Prepare this PC for ChatGPT
      -> add the custom MCP app in ChatGPT Web
      -> verify chatgpt_web_status
      -> READY
```

After that, RWMCP starts with Windows and maintains the tunnel automatically.

## 1. Download the Windows installer

Open the latest GitHub Release and download `install-windows.cmd`.

The current stable release contains:

- `install-windows.cmd`
- `install-windows.ps1`
- `remote-workstation-mcp-v0.13.1.tgz`
- `SHA256SUMS.txt`


Double-click `install-windows.cmd`. The installer checks prerequisites, downloads the verified release package, installs the runtime and OpenAI tunnel client, creates the stable launcher, configures startup, initializes automatic patch updates, and opens the local Control Center.

Normal users do **not** need to clone this repository or run `npm install`.

## 2. Create an OpenAI Secure MCP Tunnel

RWMCP keeps the workstation MCP on `127.0.0.1`. ChatGPT reaches it through an outbound OpenAI Secure MCP Tunnel.

Open OpenAI Platform **Tunnels**:

`https://platform.openai.com/settings/organization/tunnels`

Create a tunnel for this workstation, for example `Remote Workstation - Engineering PC`, then copy the generated ID:

```text
tunnel_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

The account/role creating or managing the tunnel needs the relevant **Tunnels Read + Manage** permission. The runtime user that will operate the tunnel needs **Tunnels Read + Use**.

> Keep each production workstation on its own tunnel when practical. It gives cleaner revocation, auditing, and failure isolation.

## 3. Create the Runtime API key

Open OpenAI Platform **Runtime API keys**:

`https://platform.openai.com/settings/organization/api-keys`

Create a **Restricted** runtime key and grant only:

- **Tunnels: Read**
- **Tunnels: Use**

Copy the key once and keep it private.

Do **not** use an OpenAI Admin API key as the long-lived RWMCP runtime key. Admin keys are only needed for administrative tunnel CRUD workflows.

## 4. Configure the local Control Center

The Control Center opens locally at:

```text
http://127.0.0.1:8684
```

![Control Center v0.8.1](docs/images/v0.8.1/01-control-center-home-v081.png)

Open **Settings**.

![Quick setup](docs/images/v0.8.1/02-settings-quick-setup-v081.png)

Enter:

1. **Authorized workspace root** - the folder normal Workspace-mode tools may access.
2. **Tunnel ID** - the `tunnel_...` value created above.
3. **Organization ID** - when your tunnel/account is organization-scoped or the account can address multiple organizations.
4. **Runtime API key** - the restricted Tunnels Read + Use key.
5. Keep **Store runtime key with Windows DPAPI** enabled for normal managed Windows use.

![OpenAI connection settings](docs/images/v0.8.1/03-settings-connection-v081.png)

Then choose **Prepare this PC for ChatGPT**.

The wizard saves the non-secret configuration, protects the runtime key with Windows DPAPI, verifies `tunnel-client`, starts MCP + the Secure MCP Tunnel, waits for readiness, and enables start-at-logon.

![Runtime controls](docs/images/v0.8.1/04-settings-runtime-v081.png)

## 5. Add Remote Workstation to ChatGPT Web

OpenAI currently calls this a **custom MCP app**. Older UI or documentation may call it a connector or plugin.

Current OpenAI documentation places custom MCP app setup under **ChatGPT Settings / Workspace Settings -> Apps**. Developer Mode may need to be enabled first, depending on the workspace and plan.

Typical flow:

1. Open ChatGPT Web.
2. Open **Settings -> Apps**.
3. Enable **Developer Mode** if your workspace requires it.
4. Choose **Create** / **Add custom app**.
5. Name it **Remote Workstation**.
6. Choose the **Tunnel** connection type.
7. Select the authorized tunnel or paste the same `tunnel_...` ID configured in RWMCP.
8. Keep the workstation Control Center in READY state while ChatGPT performs MCP discovery.
9. Review the discovered RWMCP tools before publishing or enabling the app for other users.

Direct settings entry point currently used by OpenAI:

`https://chatgpt.com/#settings/Connectors`

Product UI and plan availability can change independently of RWMCP. As of September 2026, OpenAI documents full MCP write/modify support on ChatGPT Web for Business, Enterprise and Edu workspaces; Pro has more limited developer-mode MCP support. Check the current OpenAI Developer Mode documentation before a wider deployment.

Detailed guide: [ChatGPT Web custom app setup](docs/CHATGPT_WEB.md).

## 6. Verify the end-to-end connection

When the workstation is configured correctly, the Control Center shows MCP healthy, tunnel READY, bearer authentication enabled, and start-at-logon ON.

![READY state](docs/images/v0.8.1/07-ready-online-v081.png)

In ChatGPT, invoke the Remote Workstation app and ask:

> Use Remote Workstation. Call `chatgpt_web_status` first. Do not modify anything. Report whether the authenticated control path is verified, the effective scopes, policy mode and authorized workspace names.

A healthy result includes:

```text
ok: true
chatgptWeb.authenticated: true
chatgptWeb.secureTunnelPrincipal: true
chatgptWeb.directControlPathVerified: true
```

Then verify `workspace_list` before allowing writes or execution.

## Access modes

RWMCP exposes exactly three owner-selected access modes:

| Mode | Meaning |
| --- | --- |
| **Read only** | Inspect files, Git state, status, and diagnostics. No writes or program execution. |
| **Workspace** | Read, write, and execute approved workflows inside owner-authorized workspaces. Recommended default. |
| **Full access** | Host filesystem and raw shell using the permissions of the current Windows user. |

**Full Access is not Administrator.**

Administrator execution is a separate one-shot path:

```text
AI request
   -> local owner approval in Control Center
   -> Windows RunAs / UAC
   -> one approved privileged execution
```

![Full access confirmation](docs/images/v0.8.1/06-full-access-confirm-v081.png)

A mode change cannot silently grant Administrator rights.

## After first setup

After the first successful setup, you do **not** need to:

- run the installer again;
- clone the repository;
- run `git pull`;
- run `npm install` or `npm build`;
- launch PowerShell manually on each boot;
- recreate the tunnel after every restart;
- re-enter the runtime API key after each update.

RWMCP automatically:

- starts after the Windows user signs in;
- starts the MCP runtime;
- reconnects the OpenAI Secure MCP Tunnel;
- keeps owner configuration and DPAPI-protected secrets outside version slots;
- checks the stable release channel when due;
- downloads and SHA-256 verifies release packages;
- installs updates into a new version slot;
- verifies MCP health and tunnel readiness;
- automatically rolls back to the previous slot when candidate activation fails.

Windows startup uses:

```text
HKCU\Software\Microsoft\Windows\CurrentVersion\Run
        |
        v
%LOCALAPPDATA%\RemoteWorkstationMCP\bin\rwmcp.ps1 -Action Boot
        |
        +--> check stable update when due
        +--> start runtime
        +--> start OpenAI tunnel
        +--> verify health/readiness
```

## Automatic patch updates

Advanced settings exposes **Automatic patch updates** and **Check for updates**.

![Advanced settings](docs/images/v0.8.1/05-settings-advanced-v081.png)

![Automatic patch updates](docs/images/v0.8.1/08-auto-update-v081.png)

Managed defaults:

```text
enabled            = true
channel            = stable
checkOnStartup     = true
checkIntervalHours = 12
```

Production updates come from GitHub Releases. RWMCP does not `git pull` a production source tree. It downloads the release package and checksum manifest, verifies SHA-256, installs a new slot, switches the active pointer, validates health/readiness, and rolls back automatically on failure.

Managed policy: patch releases (`x.y.Z`) may install automatically; minor/major releases are detected and require explicit owner approval. A manual owner-approved update may install any newer stable release.

## Managed Windows layout

```text
%LOCALAPPDATA%\RemoteWorkstationMCP\
  bin\
    rwmcp.ps1
    install-windows-release.ps1
    update-windows.ps1
  config\
  runtime\
    update-transaction.json
    update-worker.log
  secrets\
  versions\
    v0.7.9\
    v0.8.1\
  current.txt
  previous.txt
  update.json
  settings.json
  audit.jsonl
```

The stable launcher resolves `current.txt`, so startup follows the active version automatically after an update or rollback.

## v0.7.10 Control Center port ownership hardening

The default Control Center port is `8684`. v0.7.10 verifies that the listener on that port belongs to the managed Control Center process tree before reporting it healthy.

If another process owns `8684`, RWMCP does not report a false READY state. It reports the conflicting PID so the owner can close the application or choose another Control Center port in Advanced settings.

## Documentation

- [Multi-device Hub](docs/MULTI_DEVICE.md)
- [Windows quick start](docs/QUICKSTART_WINDOWS.md)
- [ChatGPT Web custom app setup](docs/CHATGPT_WEB.md)
- [OpenAI Secure MCP Tunnel](docs/OPENAI_SECURE_TUNNEL.md)
- [Windows managed runtime](docs/WINDOWS.md)
- [Setup & Control Center](docs/SETUP_CONSOLE.md)
- [Operations](docs/OPERATIONS.md)
- [Security](docs/SECURITY.md)
- [Architecture](docs/ARCHITECTURE.md)

## Development setup

The Git workflow below is for contributors only; it is not required for a normal installed workstation.

```powershell
git clone https://github.com/Tunglam0605/remote-workstation-mcp.git
cd remote-workstation-mcp
npm install
npm run typecheck
npm test
npm run build
```

## License

Apache-2.0
