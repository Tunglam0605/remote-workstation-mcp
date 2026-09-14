# ChatGPT Web custom app / MCP connection

Remote Workstation MCP is designed so ChatGPT Web can be a **first-class controller**. Codex, Claude, OpenHands, or another coding agent is optional; none is required as a middle hop.

The workstation side uses OpenAI Secure MCP Tunnel so the MCP server remains on loopback and no inbound Internet-facing port is required.

## Product/workspace availability

ChatGPT custom MCP/app availability, Developer Mode controls, write-capable tool support and workspace publication rules are product/workspace features controlled by OpenAI and can change independently of this repository.

A tunnel can be installed and validated even when the current ChatGPT account/workspace does not expose the custom-app UI. Product entitlement is separate from workstation/tunnel health.

Useful references:

- Developer Mode / MCP app documentation: `https://help.openai.com/en/articles/12584461`
- ChatGPT app settings: `https://chatgpt.com/#settings/Connectors`
- OpenAI Secure MCP Tunnel: `https://github.com/openai/tunnel-client`

## Managed Windows workstation setup

Recommended new-machine flow:

```powershell
$installer = Join-Path $env:TEMP 'rwmcp-install.ps1'
Invoke-WebRequest `
  'https://github.com/Tunglam0605/remote-workstation-mcp/releases/latest/download/install-windows.ps1' `
  -OutFile $installer
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File $installer
```

The installer opens the local Setup & Control Center. Configure:

1. an unused MCP loopback port;
2. the authorized workspace root;
3. OpenAI tunnel ID;
4. organization ID when applicable;
5. a restricted runtime API key with the required tunnel permissions;
6. Windows DPAPI persistence when unattended starts are desired;
7. managed Cloudflare mode only when the tunnel actually has managed runtime material.

The installer already installs the pinned, checksum-verified official `tunnel-client`.

Start from the Control Center or stable launcher:

```powershell
& "$env:LOCALAPPDATA\RemoteWorkstationMCP\bin\rwmcp.ps1" -Action StartOpenAI
```

Repository-development equivalent:

```powershell
npm run start:openai:windows
```

Successful workstation-side readiness means:

```text
Remote Workstation MCP /healthz -> HTTP 200
httpAuth                        -> bearer
tunnel-client /healthz          -> PASS
tunnel-client /readyz           -> PASS
```

## ChatGPT Web app creation

When the current ChatGPT workspace exposes custom MCP/app creation:

1. enable Developer Mode according to workspace policy;
2. open ChatGPT Apps / custom app settings;
3. create a custom app;
4. choose **Connection: Tunnel**;
5. select the authorized tunnel or paste its `tunnel_...` ID;
6. complete discovery while the workstation tunnel remains ready;
7. review the discovered tool set before wider workspace publication.

The tunnel must be associated with the target workspace when the OpenAI product requires workspace scoping.

## Authorization model

ChatGPT reaching the tunnel does **not** grant unrestricted workstation access. Requests still pass through:

```text
ChatGPT
  -> OpenAI Secure MCP Tunnel
  -> ephemeral local MCP bearer
  -> authenticated principal + workstation scopes
  -> local policy
  -> optional owner-issued permission lease
  -> audit
  -> typed adapter
```

The normal tunnel profile uses:

```text
workstation.read,workstation.write,workstation.execute
```

`workstation.full_control` is intentionally not included by default. Host-wide shell/filesystem actions still require the full-control scope, an active client-bound owner lease, and the relevant local dangerous-feature gate.

## Plugin package vs ChatGPT custom app

The repository includes portable Agent Plugin/Codex-compatible metadata under `plugins/remote-workstation/`. That package is useful for local/plugin-compatible clients and distribution metadata.

ChatGPT Web is not connected by exposing the local `plugin.json` or workstation port to the Internet. The private-workstation route is:

```text
ChatGPT custom app
        -> Secure MCP Tunnel
        -> authenticated loopback MCP
        -> local workstation policy
```

Portable plugin packaging and remote ChatGPT reachability are deliberately separate layers.
