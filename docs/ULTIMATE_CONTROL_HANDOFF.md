# Ultimate Control 4H and cross-node project handoff (Windows development feature)

**Release status:** implementation branch based on Windows v0.71.0; **not enabled on deployed machines**. Windows acceptance and a separate, explicit owner choice are required before rollout. Ubuntu/Linux remains on its previously released runtime: do not install the new Windows development build on Ubuntu.

## Authority boundary

Ultimate is a short-lived **additional consent for specific typed project workflows**, not a new unrestricted OS permission level.

- Only the loopback Control Center, with its existing Host/Origin and CSRF token protection, may activate (`POST /api/ultimate/activate`) or revoke (`DELETE /api/ultimate`) a consent.
- Durations are **30, 60, 120 or 240 minutes**; hard maximum **4 hours** from activation, measured against wall time **and** OS uptime. There is **no silent renewal**. Restarting the MCP runtime invalidates previous consent by changing its runtime epoch.
- The approval binds one Direct Node, authenticated Secure MCP Tunnel principal, explicit workspace(s), operation(s), existing owner-approved transfer grant(s) and build profile ID(s), and optionally one Work Session ID.
- The original owner policy and authenticated request scope apply at every opted-in workflow step. Revocation and expiry fail closed.
- Existing MCP tools and prior `full_control` mode/leases retain their independent controls. **Ultimate expiration does not turn off a persistent `full_control` base mode.** The Access page warns when that base mode remains selected.
- OS Administrator/root, UAC, external ChatGPT connection/tool approval dialogs, hardware flashing, firmware mass erase, unattended background orchestration and unbounded shell execution **are not authorized or bypassed**.
- Read-only `ultimate_control_status` reports current consent, expiration, scope and remaining time. No MCP method creates, widens or renews it.
- A bounded read-only lifecycle view reports recent activation/revocation events. Owner-local audit JSONL is kept with private runtime settings; it excludes runtime epoch and bearer secrets.

On the Windows workstation, open **Control Center → Security → Ultimate Control 4H**, choose the exact workspace and one workflow operation, choose a bounded duration, and confirm activation locally. Use **Revoke Ultimate immediately** to stop new protected workflow phases before expiry. The Control Center polls status approximately every five seconds. On Ubuntu this development feature shows unavailable/Windows-only.

## Project handoff contract

The new engineering contributions on Windows are:

| Workflow | Effect | Required Ultimate operation |
|---|---|---|
| `platform.handoff_package` | Produce deterministic ZIP with versioned manifest and per-file SHA-256, from an explicit non-secret file list; no recursive implicit copy | `workspace_add` (creates an export archive) |
| `platform.handoff_accept` | Verify received archive SHA-256, exact node/workspace/project/job identity, manifest entries and per-file hashes; import under a new directory only | `workspace_add` (writes files) |
| `platform.handoff_build_preflight` | Rehash the accepted source snapshot, reject new/modified files and require a receiver-local trusted target allowlist | `build` with the exact profile ID |

The existing public `engineering_workflow_run` envelope also requires `workstation.execute`; handoff therefore requires **both `workstation.write` and `workstation.execute`** on the authenticated Windows runtime, without raising either scope automatically.

**Limits of this first archive implementation:** maximum 2,048 files, 32 MiB contents and 32 MiB ZIP; v1 uses *stored (uncompressed)* ZIP entries only, rejecting compressed members entirely to rule out decompression-bomb amplification. It also rejects symlinks/reparse paths, path traversal, ambiguous case-insensitive names, default secret paths such as `.env` and `.git`, duplicate members, mismatched checksums and conflicting destinations. A later bounded streaming design is needed for large 512 MiB direct transfers.

The transfer itself remains provided by existing separately authorized `platform.transfer_*` or `platform.relay_*` workflows. The handoff workflow cannot create or modify grants, authorize peer commands or turn on peer access. For **each direction**, source and receiver must have a matching enabled owner grant and the exact `workstation.cross_node_transfer` scope; `workstation.full_control` does not imply it.

Before promoting an archive, Windows handoff acceptance checks its receiver-local SHA-256 sidecar, repeats the destination grant/Ultimate checks **and requires an exact receipt recorded in the receiving RWMCP runtime** following a ticket-bound direct transfer or an owner-grant-authorized relay finalization. The imported directory must be under the grant's exact receiving base. The workspace-writable sidecar is informational only; it cannot create a runtime proof. The private receipt ledger is deliberately in-memory: **restart, expiry or a different runtime require a new transfer**. It binds the expected grant, both nodes/workspaces, exact source/destination paths, file name, size, hash and transport; accepted imports also gain a runtime-local proof checked by the build preflight. This is proof of the receiver's authorized transfer workflow, **not a sender machine-key signature**. Local same-user process compromise, race-resistant directory publication and hostile project build execution remain outside its guarantees.

- **Direct:** use only after proving a private route and receiver availability, up to the exact grant limit (global maximum 512 MiB).
- **Relay:** fallback through the existing authenticated control-plane workflow, maximum 32 MiB, chunks maximum 64 KiB; both endpoints must support it and the grant must permit relay.
- A node merely appearing online behind a separate tunnel is **not evidence** that the nodes have a direct peer route.
- Loss of ChatGPT/controller connectivity does not trigger additional phases. Retry is explicit and uses persisted receipt/hash/job identifiers.

## STM32 example: Ubuntu SSD → Windows laptop → Ubuntu SSD

1. On the Ubuntu source, identify the exact approved workspace, source revision and file inventory; ensure source is a stable snapshot. **Check that its frozen runtime supports the required transfer primitives**. If it lacks the new package workflow, stage a known-good ZIP through an independently approved method; do not silently upgrade Ubuntu or enable a raw remote shell.
2. On the Windows owner machine, provision an explicit writable receiving workspace and one bilateral SSD→Windows grant. The Ubuntu owner policy must independently approve the same grant, including the concrete `exports` source-path prefix and `.zip` allowed extension, destination base, byte cap and transport. Both endpoints require the dedicated transfer scope.
3. Create the versioned source ZIP, capture exact archive SHA-256 and size, transfer using an individually planned direct or relay operation, then accept it into a **new** destination directory. Validate source revision and the requested build profile.
4. A receiver-owned allowlist, **not** any `.rwmcp/project.yaml`, scripts or hooks supplied by the incoming project, must select an exact Keil/CMake target. Put the following file in the private Windows Setup directory (`setupConfigDir()/ultimate-build-profiles.json`), with its exact source revision/target/workspace adapted to the approved project. Never copy this file into the incoming project:

   ```json
   {
     "schemaVersion": 1,
     "profiles": [{
       "id": "owner-stm32f407-cmake",
       "projectId": "f4",
       "target": "STM32F407",
       "sourceNodeId": "ssd",
       "sourceRevision": "REPLACE_WITH_APPROVED_REVISION",
       "destinationWorkspace": "builds",
       "allowed": true
     }]
   }
   ```

   Run `platform.handoff_build_preflight` with `handoffAcceptedRelativePath`, `handoffProfileId`, and `handoffTarget`. Planning and execution both require active Ultimate `build` consent for the exact profile and compute a fresh file-by-file manifest hash scan; unlisted files, modified sources, symlinks and unapproved profiles fail closed. The `sourceRevision` is an exact declared source identifier **not an independently verified Git commit**. This preflight does **not** execute a compiler, lock files against later modification, inspect every possible build hook, or permit flashing. Actual compilation remains a separately authorized existing typed `firmware.build` action; revalidate immediately before building and run untrusted build systems only in a deliberately isolated environment.
5. Package the resulting `.bin`, `.hex`, `.elf` or `.axf` files as `build_artifacts`, use a distinct Windows→SSD grant for the return direction, and verify the reverse receipt/hashes. The return is **not** an authorization to flash a board. Flash requires a separate explicit hardware-mutation decision.

## Acceptance before rollout

- Windows disposable installer/build acceptance for `npm run verify`, Control Center authorization and restart behavior, package and installer checksum; no activation on Ubuntu.
- End-to-end two-workspace fixture: export ZIP → simulated receipt → trusted-build preflight → simulated output ZIP → reverse receipt; assert hashes and no source mutation. Direct transfer integration also verifies that only a successful ticket-bound receive (not a generic local file accept or sidecar) creates a private runtime receipt. The fixture does **not** build real STM32 firmware or communicate with hardware.
- Independent owner confirmation of selected real machines, workspace names, profile IDs, exact bilateral grants and first project; no automatic policy/scopes changes or deployment from a source branch.
- Do not enable automated promotion into concurrently writable/untrusted project directories until atomic no-replace directory commit and Windows junction/reparse-point races are acceptance-tested. In this development build, workspace path validation and staged imports do not constitute a complete defense against a hostile concurrent writer.
- Build preflight now loads a receiver-local owner registry and computes a fresh source-file inventory/checksum scan, but it is **not** yet coupled to a real Git cleanliness check, full build-hook inspection, OS-isolated compilation or a Windows compiler invocation. Do not label simulated tests as actual STM32 build success.
- The Windows laptop runtime and the frozen Ubuntu SSD runtime must each be online for compatibility/transport acceptance. On 2026-10-24 the Windows MCP tunnel was not connected, while the SSD reported stable `0.67.2-ubuntu.1`; no Windows test or endpoint upgrade has been performed.

If an endpoint is incompatible, lacks a grant/scope, is offline, or only offers an unreachable direct route, report that exact blocker. Do not weaken policy or fall back to arbitrary remote command execution.
