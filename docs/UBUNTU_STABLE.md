# RWMCP Ubuntu maintenance track — 0.67.2-ubuntu.1

## Status and scope

This is an **Ubuntu candidate built from the v0.67.1 stable tag**, maintained separately from the Windows-led `main` branch. It is **not** a replacement for current Windows `0.68+` / `0.70-dev` features. Do not merge Windows-only PCB/EDA automation into this branch without Linux acceptance evidence.

Production intent: a predictable **Direct Node** on Ubuntu 24.04 LTS and Ubuntu 26.04 LTS for Git, SSH, ROS 2, camera and sensor integration, system inspection, read-only engineering diagnostics and owner-authorized typed workflows. KiCad may be used for diagnostics where installed; visual PCB CAD automation is **not a dependency or acceptance gate** for Ubuntu. A headless deployment is supported.

## Changes in this candidate

- Retains v0.67.1 per-context extension initialization so Media workflow contribution IDs are registered once, not once per HTTP request. Regression test simulates 50 server creations.
- Fixes `StartLimitIntervalSec` and `StartLimitBurst` placement in the user systemd unit: both belong under `[Unit]`.
- Makes `doctor-user.mjs` aware of managed user-local `~/.local/bin` tooling and systemd's user bus when launched over SSH/MCP.
- Allows `direct-node-status-linux.sh` to query readiness via `wget` when `curl` is missing.
- Allows `rollback-user.sh` to check health via Node's native `fetch`, removing an unnecessary `curl` runtime dependency, and reconstructs the SSH user bus.
- Preserves the existing MCP tool schema (Action Schema 51) and Engineering API 5, with no new scopes or bypasses.

## Rollout / safety gates

1. Back up `~/.config/remote-workstation-mcp`, existing systemd user unit files and symlink targets (`current`, `previous`). Do not copy API keys or bearer tokens into reports.
2. Verify `node >=22`, local `npm`, `tar`, a working existing tunnel, and no active production work sessions. Do not reinstall or rotate the tunnel during an upgrade.
3. Use `RWMCP_UPDATE_MODE=notify` (not `auto_patch` or `auto`) on Ubuntu, since upstream Windows releases can exceed the Ubuntu maintenance baseline.
4. Run `npm run typecheck`, targeted Ubuntu regression, `npm test`, `npm run build`, then in a separate staging directory the packaged runtime smoke test.
5. Deploy to **one canary Direct Node**; assert `/healthz` and tunnel `/readyz`, run repeated authenticated MCP `initialize`, `tools/list` and `tools/call`, and verify `chatgpt_web_status`, `workspace_list` and read-only `system_info` via its actual ChatGPT app.
6. Require explicit owner confirmation before rolling out to a second production node with active video/camera services. An RWMCP service restart must not restart unrelated camera/ROS 2 workloads.
7. Roll back by restoring `current` to its saved path and restarting only `remote-workstation-mcp-openai.service`; verify the old version remains healthy. Keep `previous` intact.

## Compatibility

| Ubuntu baseline | Role | Minimum acceptance |
| --- | --- | --- |
| Ubuntu 24.04 LTS | SSD/headless or desktop control node | SSH recovery, systemd user service, MCP/tunnel, registry lifecycle |
| Ubuntu 26.04 LTS | Vision/video and robotics PC | Above plus camera/ROS 2 services remain intact across MCP-only restart |

**Non-goals:** Windows COM automation, Keil, AutoCAD, TIA Portal, PCB autorouting/interactive CAD, Windows recovery plane and automatic upgrade to newer Windows-only stable releases.

## Development note

The upstream platform support policy currently freezes Ubuntu. This branch explicitly overrides that policy **only for the separate Linux maintenance line**; the Windows release train and Windows code remain unchanged. Publish Ubuntu-specific release artifacts and verification evidence separately; never overwrite a canonical Windows release tag.
