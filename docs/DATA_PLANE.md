# Generic Direct-Node Data Plane

Remote Workstation MCP v0.14 moves cross-node payload transfer into the **core platform** instead of treating it as a firmware-only capability. v0.14.1 adds multi-endpoint direct transport after real acceptance proved that two healthy Direct Nodes can have Tailscale addresses without belonging to the same Tailscale peer graph. v0.14.2 adds a bounded control-plane relay after acceptance further proved that independently reachable Direct Nodes may have no mutual route at all.

The control plane remains ChatGPT/MCP. Large file bytes move directly between owner-controlled Direct Nodes whenever a peer path exists; the authenticated control path is only a bounded fallback.

```text
ChatGPT / MCP control plane
        |
        | offer metadata / ticket / receipt
        v
   Direct Node A  ==================>  Direct Node B
                approved direct data plane
          Tailscale peer path or private LAN
                  streamed file bytes
```

## Why this is core

The data plane is intentionally independent of STM32, ESP32, ROS 2, vision and OTA. It can carry any regular file inside an authorized workspace, including:

- build artifacts;
- logs and crash dumps;
- reports;
- camera evidence;
- datasets;
- ROS bags;
- configuration bundles;
- firmware artifacts.

Domain extensions may add extra validation after a generic transfer, but they must not redefine the transport itself.

## Stable workflow surface

v0.14.0 exposes the first platform workflows through the existing generic `engineering_workflow_plan` / `engineering_workflow_run` envelope so `actionSchemaVersion` remains 2:

- `platform.transfer_prepare`
- `platform.transfer_receive_offer`
- `platform.transfer_push`
- `platform.relay_read_chunk`
- `platform.relay_begin`
- `platform.relay_status`
- `platform.relay_write_chunk`
- `platform.relay_finalize`
- `platform.relay_abort`

The historical tool name `engineering_workflow_*` is retained for action-schema compatibility. The `platform.*` workflow IDs are core-platform workflows and do not require firmware capability.

### `platform.transfer_prepare`

Required parameters:

```json
{
  "file": "relative/path/report.json"
}
```

It resolves the file inside the selected `workspace` + `projectPath` base, verifies that it is a regular file, streams it through SHA-256 locally, and returns:

- relative file path;
- exact byte size;
- SHA-256.

No network I/O or file mutation occurs.

### `platform.transfer_receive_offer`

Required parameters:

```json
{
  "fileName": "report.json",
  "expectedSha256": "<64 hex characters>",
  "expectedSize": 12345
}
```

Optional:

```json
{ "transferTimeoutMs": 120000 }
```

The destination node:

1. requires workspace write permission;
2. discovers approved local direct IPv4 candidates: Tailscale plus physical RFC1918 private-LAN interfaces;
3. filters common Docker/bridge/virtual tunnel interfaces from automatic private-LAN discovery;
4. opens ephemeral HTTP listeners only on candidates that bind successfully;
5. creates one random 256-bit one-shot bearer ticket shared by those listeners;
6. binds the offer to exact file name, SHA-256, byte size and expiry;
7. returns `endpoints[]` plus the first legacy `endpoint` and the ticket once.

The ticket is not included in workflow plans, `nodeHealth`, capability inventory, or transfer history.

### `platform.transfer_push`

Required parameters:

```json
{
  "file": "relative/path/report.json",
  "transferEndpoints": [
    "http://100.x.y.z:<port>/rwmcp-data/<transfer-id>",
    "http://192.168.x.y:<port>/rwmcp-data/<transfer-id>"
  ],
  "transferTicket": "<ephemeral ticket>",
  "expectedSha256": "<64 hex characters>",
  "expectedSize": 12345
}
```

The source re-hashes the local file before network I/O. A mismatch blocks before any payload is sent. It then tries the bounded direct endpoint list in order. Network-unreachable candidates may fall through to the next endpoint; an HTTP receiver rejection such as invalid ticket, expiry or integrity failure is authoritative and fails closed. `transferEndpoint` remains accepted for compatibility.

## Bounded control-plane relay fallback

Direct transfer remains preferred. v0.14.2 adds a fallback for a different topology: both workstations are independently reachable through authenticated Direct Node MCP tunnels, but the workstations cannot open a peer route to one another.

The relay uses the existing stable workflow envelope:

- `platform.relay_read_chunk` on the source;
- `platform.relay_begin` on the destination;
- `platform.relay_status` to recover the next required offset;
- `platform.relay_write_chunk` on the destination;
- `platform.relay_finalize` after all bytes arrive;
- `platform.relay_abort` for explicit cleanup.

Recommended orchestration is:

```text
source Direct Node                         destination Direct Node
------------------                         -----------------------
transfer_prepare
                                              relay_begin
relay_read_chunk(offset=0)
      | bounded base64 result
      +-------------------------------------> relay_write_chunk(offset=0)
relay_read_chunk(offset=65536)
      +-------------------------------------> relay_write_chunk(offset=65536)
...
                                              relay_finalize
                                              full SHA-256 + size
                                              atomic verified promotion
```

The orchestration layer should pass the source chunk result directly into the destination write tool call and should not render `dataBase64` into the chat response.

Relay properties:

- maximum file size: **32 MiB**;
- maximum chunk size: **64 KiB**;
- binary-safe base64 transport;
- exact sequential offset;
- SHA-256 for every chunk;
- persistent session state with default 30-minute and maximum 60-minute TTL;
- restart/resume through `platform.relay_status`;
- final full-file SHA-256 and size verification through the same atomic verified store used by direct transfer;
- destination write permission is enforced locally;
- no relay depends on a permanent master workstation.

This fallback traverses the already-authenticated MCP control paths and is therefore intentionally bounded. It is not a replacement for the direct data plane for large datasets, ROS bags or bulk artifacts.

## Destination acceptance

On receipt the destination:

1. checks the one-shot ticket;
2. requires exact `Content-Length`;
3. requires the declared SHA-256 to match the offer;
4. hashes bytes while streaming to a temporary file;
5. verifies exact received size and digest;
6. stream-copies and hashes again during atomic verified-store promotion;
7. removes incoming staging bytes;
8. closes the ephemeral listener.

Verified files are content-addressed under:

```text
.rwmcp/transfers/verified/<sha256>-<basename>
```

with a sibling JSON verification manifest.

Existing matching verified content is reused idempotently. Existing different content at the same content-addressed destination fails closed.

## Limits

- direct-transfer maximum file size: **512 MiB**;
- control-plane relay maximum file size: **32 MiB**;
- control-plane relay maximum chunk size: **64 KiB**;
- workspace-relative regular files only;
- production receiver bind: approved Tailscale or RFC1918 private IPv4 only;
- common Docker/bridge/tunnel interfaces are excluded from automatic private-LAN discovery;
- production peer endpoint: Tailscale or RFC1918 private IPv4 only;
- maximum endpoint candidates per push: **8**;
- one-shot tickets;
- offer TTL: 10 seconds to 10 minutes;
- response body is bounded;
- no arbitrary destination overwrite;
- no public Internet listener;
- no ticket in status/history.

Loopback endpoints are available only to the automated test harness.

## Node health integration

`chatgpt_web_status` now includes a non-secret `nodeHealth` snapshot:

```text
nodeHealth
  state
  runtimeUptimeSeconds
  osUptimeSeconds
  memory
  activeSessions
    processes
    terminals
    hardwareLeases
  dataPlane
    directIpv4Available
    tailscaleIpv4Available
    privateLanIpv4Available
    availableTransports
    activeOffers
    recentTransfers
    controlPlaneRelay
      supported
      maxRelayBytes
      maxChunkBytes
      resumable
      persistentSessionState
  warnings
```

This allows ChatGPT to call each independent Direct Node and aggregate multi-node health without introducing a permanent master workstation.

## Compatibility

v0.13.6 `firmware.artifact_receive_offer` and `firmware.artifact_push` remain available for compatibility. They remain firmware-domain APIs with the stricter firmware artifact rules.

New generic work should prefer `platform.transfer_*` unless a firmware-specific integrity workflow is intentionally required.

## Security model

The normal MCP server stays bound to loopback. Temporary direct data-plane listeners are separate one-shot surfaces bound only to approved direct interfaces. Tailscale remains preferred when the peer path exists; RFC1918 private-LAN fallback is available when nodes share a trusted reachable local network. This does not make MCP itself LAN-accessible.

If neither direct path works, the control-plane relay uses each node's existing authenticated MCP tunnel rather than opening a new public listener. Relay chunks are bounded and individually hashed, while final acceptance still depends on the destination's local workspace write policy and full-file integrity contract.

The data plane does not grant access to another node. Each destination still enforces its own local workspace policy and write permission.
