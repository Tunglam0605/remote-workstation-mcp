# Generic Direct-Node Data Plane

Remote Workstation MCP v0.14.0 moves cross-node payload transfer into the **core platform** instead of treating it as a firmware-only capability.

The control plane remains ChatGPT/MCP. Large file bytes move directly between owner-controlled Direct Nodes.

```text
ChatGPT / MCP control plane
        |
        | offer metadata / ticket / receipt
        v
   Direct Node A  ==================>  Direct Node B
                  Tailscale data plane
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
2. locates a local Tailscale IPv4 address (`100.64.0.0/10`);
3. opens one ephemeral HTTP listener on that address only;
4. creates a random 256-bit one-shot bearer ticket;
5. binds the offer to exact file name, SHA-256, byte size and expiry;
6. returns the endpoint and ticket once.

The ticket is not included in workflow plans, `nodeHealth`, capability inventory, or transfer history.

### `platform.transfer_push`

Required parameters:

```json
{
  "file": "relative/path/report.json",
  "transferEndpoint": "http://100.x.y.z:<port>/rwmcp-data/<transfer-id>",
  "transferTicket": "<ephemeral ticket>",
  "expectedSha256": "<64 hex characters>",
  "expectedSize": 12345
}
```

The source re-hashes the local file before network I/O. A mismatch blocks before any payload is sent.

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

- maximum file size: **512 MiB**;
- workspace-relative regular files only;
- production receiver bind: Tailscale IPv4 only;
- production peer endpoint: Tailscale IPv4 only;
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
    tailscaleIpv4Available
    activeOffers
    recentTransfers
  warnings
```

This allows ChatGPT to call each independent Direct Node and aggregate multi-node health without introducing a permanent master workstation.

## Compatibility

v0.13.6 `firmware.artifact_receive_offer` and `firmware.artifact_push` remain available for compatibility. They remain firmware-domain APIs with the stricter firmware artifact rules.

New generic work should prefer `platform.transfer_*` unless a firmware-specific integrity workflow is intentionally required.

## Security model

The normal MCP server stays bound to loopback. The temporary data-plane listener is a separate one-shot surface bound to the owner's encrypted Tailscale interface.

The data plane does not grant access to another node. Each destination still enforces its own local workspace policy and write permission.
