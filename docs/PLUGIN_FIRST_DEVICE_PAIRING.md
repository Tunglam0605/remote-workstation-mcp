# Plugin-first device pairing architecture

## Product goal

The ChatGPT-side experience should be as close as possible to:

1. install **Remote Workstation** once from ChatGPT Web;
2. connect/authorize the app once;
3. ask `Pair a new workstation` when another PC must be added;
4. run one small workstation bootstrap on that PC and enter/accept a short-lived pairing code;
5. use that PC from ChatGPT without creating another ChatGPT app, tunnel profile, API key, port mapping, Node checkout, or manual MCP configuration.

A completely unprepared PC cannot be controlled by a browser-only ChatGPT plugin: local files, processes, serial ports, debuggers and SSH credentials require a local trusted component. The supported minimum is therefore **one plugin installation per ChatGPT account/workspace + one local agent installation per workstation**.

## Why the current direct-tunnel model is not the final multi-device UX

v0.7.3 uses a direct relationship:

```text
ChatGPT app -> OpenAI Secure MCP Tunnel -> one local Remote Workstation MCP runtime
```

This is secure and remains a supported self-hosted mode, but repeating Tunnel ID, Organization ID, runtime API key and connector setup for every PC does not scale to the desired user experience.

## Target architecture

```text
                         ChatGPT Web
                             |
                    Remote Workstation Plugin
                             |
                     Remote Workstation App
                             |
                    stable MCP control endpoint
                             |
                  +----------+-----------+
                  | Workstation Hub      |
                  | device registry      |
                  | pairing authority    |
                  | policy/audit router  |
                  +----------+-----------+
                             |
            outbound authenticated device sessions
                  +----------+----------+
                  |                     |
            Windows Agent          Linux Agent
                  |                     |
        files/git/process/debug    files/git/process
```

The plugin/app never receives raw workstation secrets. Each workstation has a unique device identity and establishes an outbound authenticated session. The Hub routes typed MCP operations only to the selected authorized device.

## User flow

### First ChatGPT install

The user installs the Remote Workstation plugin/app from ChatGPT Web and authorizes it. This is the only ChatGPT-side installation step.

### Pair a workstation

A ChatGPT action creates a short-lived pairing request:

```json
{
  "pairing_id": "pair_...",
  "code": "ABCD-EFGH",
  "expires_in_seconds": 600
}
```

The user runs the workstation bootstrap/installer. The bootstrap asks only for the pairing code (or accepts a signed pairing URI). It then:

1. installs the signed/versioned Remote Workstation Agent;
2. generates a device keypair locally;
3. exchanges the one-time pairing code for a device credential;
4. stores the credential using OS-protected secret storage;
5. registers a user-level background service/autostart entry;
6. connects outbound to the Hub;
7. reports health/capabilities;
8. enables self-update/rollback.

After pairing, ChatGPT can list/select the workstation by owner-defined name.

## Security requirements

- Pairing codes are single-use and expire quickly.
- Pairing exchanges bind the resulting credential to a generated device public key.
- Device credentials are revocable individually.
- No shared runtime API key across workstations.
- No workstation accepts unsolicited inbound Internet connections.
- Hub-to-device commands remain typed and policy-checked.
- Dangerous capabilities still require explicit local policy gates and, where applicable, time-limited elevation leases.
- Plugin/app install must never imply full-control permission.
- Audit records include ChatGPT principal, device id, capability, action, result and correlation id.
- Local agent secrets are kept in DPAPI/Keychain/libsecret-compatible storage; never in repository files.

## Compatibility modes

### Direct mode

Existing v0.7.3 Secure MCP Tunnel support remains available for a single workstation or fully self-hosted deployments that do not want a Hub.

### Hub mode

Hub mode is the recommended multi-device/plugin-first path. ChatGPT connects once. Additional workstations are paired rather than registered as separate ChatGPT apps.

## Implementation phases

### Phase A — device identity and pairing protocol

- `DeviceId`, device keypair and signed challenge/response.
- one-time `PairingRequest` with TTL and single-use state.
- device registration/revocation model.
- deterministic protocol schemas and tests.

### Phase B — agent transport

- outbound TLS/WebSocket or HTTP/2 session from workstation to Hub;
- heartbeats and capability inventory;
- request/response correlation;
- bounded reconnect with jitter;
- explicit offline state.

### Phase C — Hub MCP router

- one stable MCP surface for ChatGPT;
- `device_list`, `device_status`, `device_select`, `device_pair_create`, `device_revoke`;
- route existing filesystem/git/process/SSH/debug tools to a target device;
- preserve principal/scopes/policy/audit across the hop.

### Phase D — one-click workstation bootstrap

Windows target:

```text
Download installer -> enter pairing code -> done
```

No Git clone, Node setup, Tunnel ID, Organization ID or OpenAI runtime API key on ordinary paired devices.

### Phase E — ChatGPT plugin/app distribution

- Apps SDK packaging for the Hub MCP surface;
- submission assets, privacy policy and support metadata;
- Plugin Directory submission when product requirements are satisfied;
- keep custom-app installation as the development/internal-workspace fallback.

## Non-goals

- silently installing software on a never-prepared PC from ChatGPT Web;
- bypassing ChatGPT workspace/admin/plugin entitlement controls;
- sharing one unrestricted credential across all PCs;
- exposing raw shells or host filesystems simply because a device is paired.

## Acceptance criteria

The target UX is achieved when:

1. ChatGPT plugin/app is installed once;
2. an already-paired workstation requires no terminal interaction to reconnect after reboot;
3. a new Windows workstation requires only one installer launch plus one short-lived pairing code;
4. no OpenAI Tunnel ID/API key setup is repeated per paired workstation;
5. multiple devices can be listed, selected, revoked and audited independently;
6. existing direct-tunnel v0.7.x deployments continue to work.
