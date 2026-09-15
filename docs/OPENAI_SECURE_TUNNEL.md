# OpenAI Secure MCP Tunnel

Remote Workstation MCP v0.7.10 connects a private Windows workstation to supported OpenAI-hosted MCP consumers through OpenAI Secure MCP Tunnel while keeping the workstation MCP bound to loopback.

The tunnel is outbound from the workstation. It provides reachability, not unrestricted authorization: RWMCP still applies authenticated scopes, local access mode/policy, path guards, process restrictions, Administrator approval rules, and audit logging.

## Network model

```text
ChatGPT / OpenAI-hosted MCP consumer
              |
      OpenAI Secure MCP Tunnel
              |
         tunnel-client
              |
 Authorization: Bearer <ephemeral local token>
              |
      127.0.0.1:8683/mcp
              |
 authenticated request principal
              |
       local RWMCP policy
              |
             audit
              |
      workstation adapters
```

No router port-forwarding or public workstation listener is required.

## Values you need

### Tunnel ID

Create or inspect it at:

`https://platform.openai.com/settings/organization/tunnels`

The ID uses the form:

```text
tunnel_<32-hex-characters>
```

RWMCP stores this as non-secret setup state.

### Runtime API key

Create it at:

`https://platform.openai.com/settings/organization/api-keys`

Use a **Restricted** runtime key with:

```text
Tunnels Read
Tunnels Use
```

This is the key used by `tunnel-client doctor` and `tunnel-client run` and corresponds to `CONTROL_PLANE_API_KEY`.

Do not use an OpenAI Admin API key for the long-running runtime process. Admin keys are only needed for tunnel administration workflows.

### Organization ID

Set the Organization ID when the tunnel is organization-scoped or the account can address more than one organization. The Control Center persists this non-secret identifier outside application version slots.

## Permission model

Recommended OpenAI permission split:

| Actor | Tunnel permissions |
| --- | --- |
| Runtime user / daemon principal | Read + Use |
| Tunnel manager | Read + Manage |
| Manager who also runs/attaches the tunnel | Read + Manage + Use |

A tunnel intended for a specific ChatGPT workspace should be scoped/associated appropriately so authorized app users can select it.

## v0.7.10 managed Windows setup

The recommended production path does not require a Git checkout.

1. Download `install-windows.cmd` from the v0.7.10 GitHub Release.
2. Run it once.
3. Open the local Control Center at `http://127.0.0.1:8684`.
4. Enter workspace root, Tunnel ID, Organization ID when applicable, and the restricted Runtime API key.
5. Keep **Store runtime key with Windows DPAPI** enabled.
6. Choose **Prepare this PC for ChatGPT**.

The managed installer already installs and verifies the pinned official `tunnel-client` build.

Non-secret setup values are stored outside the repository under:

```text
%LOCALAPPDATA%\RemoteWorkstationMCP\settings.json
```

The runtime key is stored separately as a current-user DPAPI blob:

```text
%LOCALAPPDATA%\RemoteWorkstationMCP\secrets\openai-runtime-api-key.dpapi
```

The decrypted key is not read back into the browser after saving.

## Startup sequence

When RWMCP starts OpenAI mode, the managed runtime performs this sequence:

1. start Remote Workstation MCP on loopback with bearer authentication;
2. wait for local MCP `/healthz`;
3. generate a fresh local MCP bearer unless the owner supplied one explicitly;
4. build the tunnel profile using secret references rather than embedding the bearer in the profile;
5. run tunnel-client diagnostics;
6. start `tunnel-client`;
7. wait for tunnel-client `/readyz`;
8. report READY only after the expected local and tunnel health checks pass.

The OpenAI runtime API key is not forwarded into the MCP child-process environment.

## Automatic startup

Managed Windows installations register the stable launcher in:

```text
HKCU\Software\Microsoft\Windows\CurrentVersion\Run
```

The entry invokes:

```text
%LOCALAPPDATA%\RemoteWorkstationMCP\bin\rwmcp.ps1 -Action Boot
```

Boot checks the stable update channel when due, then starts RWMCP and the OpenAI tunnel and verifies readiness.

## Verify locally

RWMCP MCP health:

```powershell
Invoke-RestMethod http://127.0.0.1:8683/healthz
```

Expected managed tunnel operation includes an installed v0.7.10 runtime and bearer-authenticated MCP transport.

The Control Center should show:

```text
MCP       HEALTHY
Tunnel    READY
Auth      bearer
```

For most users, the Control Center is the preferred health view. Direct tunnel-client commands are mainly for deeper diagnostics.

## ChatGPT Web attachment

Only create/test the ChatGPT custom MCP app after the workstation tunnel is READY.

Typical current product flow:

1. enable Developer Mode if required by the workspace;
2. open ChatGPT **Settings -> Apps**;
3. create a custom MCP app named **Remote Workstation**;
4. choose **Tunnel**;
5. select or paste the same `tunnel_...` ID;
6. review discovered tools;
7. verify `chatgpt_web_status` before writes/execution.

See [ChatGPT Web custom app setup](CHATGPT_WEB.md).

## Managed Cloudflare material

Managed Cloudflare runtime material is optional. Leave the related option disabled unless OpenAI explicitly provisioned managed runtime material for the tunnel.

If diagnostics return a message equivalent to managed Cloudflare runtime material not found, keep managed Cloudflare disabled. This does not by itself mean the MCP bearer or RWMCP policy is invalid.

## Security boundary

The tunnel does not bypass local authorization.

The default secure path separates:

- OpenAI tunnel authentication;
- request-scoped RWMCP principal/scopes;
- owner-selected Read only / Workspace / Full access mode;
- local full-control gates;
- Administrator approval;
- audit.

Full access is not Administrator. Administrator requests still require local owner approval and Windows RunAs/UAC.

## Common failures

### `401` or `403` from the tunnel control plane

Check the Runtime API key and confirm its principal has Tunnels Read + Use for the target tunnel and intended scope.

### Tunnel ID rejected

Confirm the ID was copied from OpenAI Tunnels management and uses the expected `tunnel_...` format.

### Tunnel starts but ChatGPT discovery fails

Confirm:

- local MCP health passes;
- tunnel `/readyz` is ready;
- ChatGPT uses the same tunnel ID;
- tunnel workspace association is correct;
- the current ChatGPT workspace supports the required custom MCP app capability.

### MCP port conflict

Use the Control Center's port recommendation or configure another loopback MCP port.

### Control Center port 8684 is occupied

v0.7.10 verifies that a listener on 8684 actually belongs to the managed Control Center process tree. A foreign listener is rejected instead of being reported as healthy, and the conflicting PID is surfaced for troubleshooting.

## Manual stable-launcher operations

```powershell
$ctl = "$env:LOCALAPPDATA\RemoteWorkstationMCP\bin\rwmcp.ps1"
& $ctl -Action Status
& $ctl -Action StartOpenAI
& $ctl -Action Restart
& $ctl -Action UpdateCheck
```

Normal installed users should rarely need these after first setup.

## References

- OpenAI `tunnel-client`: `https://github.com/openai/tunnel-client`
- Tunnels management: `https://platform.openai.com/settings/organization/tunnels`
- Runtime API keys: `https://platform.openai.com/settings/organization/api-keys`
- ChatGPT app settings: `https://chatgpt.com/#settings/Connectors`
- OpenAI Developer Mode / MCP app help: `https://help.openai.com/en/articles/12584461`
