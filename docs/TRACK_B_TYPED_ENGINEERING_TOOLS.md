# Track B — Typed Engineering Tools Expansion

## Scope boundary

Track B extends Remote Workstation MCP as a secure engineering execution/control plane. It does not add planning, strategy selection, autonomous task progression, agent creation, or default worker-provider activation. ChatGPT Web remains the reasoning and decision layer.

This track deliberately reuses the existing `engineering_workflow_list`, `engineering_workflow_plan`, and `engineering_workflow_run` envelope instead of adding many new top-level MCP actions. Action Schema 5 and Engineering API 4 remain the compatibility baseline.

## Baseline audit and gap matrix

| Domain | v0.19 capability already present | Gap found | Track B abstraction |
| --- | --- | --- | --- |
| ESP32 / ESP-IDF | Project detection, typed build, flash plan/flash, serial monitor workflows | No bounded provider/project diagnostic snapshot | `espidf.diagnostics` |
| ROS 2 | Typed colcon build; node/topic/service/action/parameter/bag tools; `ros2.health` workflow | Health did not include package inventory in one reusable diagnostic envelope | `ros2.diagnostics` |
| Docker | List/inspect/log/start/stop/exec/image build; high-risk classification | No aggregate daemon + container-state diagnostic snapshot | `docker.diagnostics` |
| systemd | No typed adapter | Shell would otherwise be required for service state/journal/restart | `systemd.service_diagnostics`, `systemd.service_restart` |
| Engineering diagnostics | Compiler diagnostics, firmware/debug/ROS 2 primitives | Cross-domain diagnostics required repeated low-level calls | Stable domain workflows above |
| CAN / RS485 | Resource/concurrency vocabulary exists | No bounded bus adapter yet | Deferred until the first four domains pass integration |
| Network diagnostics | SSH/device/bootstrap and cross-node data plane exist | No dedicated bounded network diagnostic model | Deferred |
| KiCad | No dedicated adapter | Requires a separate file/project-operation threat model | Deferred |

## Safety contracts

### ESP-IDF

`espidf.diagnostics` may inspect the detected project, execute the constrained ESP-IDF version probe, list firmware artifacts, and report discovered serial ports. It never flashes, erases, changes eFuse/option state, or selects an implicit first serial port.

### ROS 2

`ros2.diagnostics` reuses the existing profile-managed ROS 2 bootstrap and combines graph health with package inventory. It does not call services, set parameters, publish messages, or start navigation/action goals.

### Docker

`docker.diagnostics` reports Docker daemon risk plus container runtime state. Existing high-risk mutation policy remains authoritative. It does not start, stop, exec, build, or otherwise mutate a container.

### systemd

Unit names are explicit and syntactically bounded. Diagnostics uses typed `systemctl show` plus a bounded journal tail. Restart:
- requires effective `full_control`;
- requires an exact match in local-owner `systemd.allowRestartUnits`;
- has an empty allowlist by default;
- does not invoke sudo or a shell;
- performs post-restart diagnostics.

There is no wildcard or implicit unit selection.

## Integration boundary with Track A

Track B does not modify Work Session ownership, project attach/resume, checkpoint/handoff, stale-session lifecycle, conflict visibility, or multi-chat UX. Workflow parameters automatically remain compatible with the existing persisted typed workflow contract, so Track A can integrate them without a competing session architecture.

## Acceptance gates

Before integration:
1. targeted domain tests pass;
2. full unit/security regression passes;
3. TypeScript typecheck passes;
4. production build passes;
5. plugin validation passes;
6. Linux CI exercises the systemd adapter path;
7. Worker Provider Registry remains default-empty;
8. no production tag/release/rollout is created by Track B.
