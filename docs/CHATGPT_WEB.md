# ChatGPT Web custom app / MCP connection

Remote Workstation MCP is designed so ChatGPT Web can be a **first-class controller**. Codex, Claude, OpenHands, or another coding agent is optional; none is required as a middle hop.

The workstation side uses OpenAI Secure MCP Tunnel so the MCP server remains on loopback and no inbound Internet-facing port is required.

## Product/workspace availability

As of September 2026, OpenAI documents full custom MCP support including write/modify on ChatGPT Web for Business, Enterprise and Edu workspaces. Pro can use more limited developer-mode MCP capabilities, while Plus should not be assumed to support the full write-capable custom-app flow.

A tunnel can be installed and validated even when the current ChatGPT account/workspace does not expose the required custom-app UI. Product entitlement is separate from workstation/tunnel health.

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

The installer opens the local Setup & Control Center. Configure the authorized workspace, OpenAI Tunnel ID, organization ID when applicable, and a restricted runtime API key. For unattended starts, store the runtime key with Windows DPAPI and enable start-at-logon.

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
3. create a custom app named **Remote Workstation**;
4. choose **Connection: Tunnel**;
5. select the authorized tunnel or paste its `tunnel_...` ID;
6. complete discovery while the workstation tunnel remains ready;
7. review the discovered tool set before wider workspace publication.

The tunnel must be associated with the target workspace when the OpenAI product requires workspace scoping.

## First end-to-end verification

v0.7.4 adds `chatgpt_web_status` specifically for the first call from ChatGPT Web.

Recommended first prompt:

> Use Remote Workstation. Call `chatgpt_web_status` first. Do not modify anything. Report whether the authenticated control path is verified, the effective scopes, policy mode and authorized workspace names.

A successful tunnel-backed result should include:

```text
ok: true
chatgptWeb.authenticated: true
chatgptWeb.secureTunnelPrincipal: true
chatgptWeb.directControlPathVerified: true
chatgptWeb.permissions.read: true
```

The normal secure-tunnel supervisor grants `workstation.read`, `workstation.write` and `workstation.execute` unless the owner narrows `RWMCP_HTTP_SCOPES`. `workstation.full_control` is not granted by default.

After `chatgpt_web_status` passes, verify in this order:

1. `workspace_list`;
2. `git_status` or `fs_read` in an authorized workspace;
3. a disposable `fs_write` and read-back;
4. one harmless allowlisted task/process;
5. inspect the audit log and confirm the authenticated OpenAI tunnel principal is recorded.

Do not enable raw shell or host filesystem merely to complete acceptance.

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
workstation.read,workstation.write,workstation.execute,workstation.admin_request
```

`workstation.full_control` is intentionally not included in the default Workspace mode. `workstation.admin_request` only permits creating/checking a pending Administrator request; local Control Center approval is mandatory before elevation, then Windows RunAs/UAC follows the machine policy. Host-wide user-level shell/filesystem access becomes available only when the local owner selects Full access (or uses a compatible legacy temporary lease).

## Completion boundary before multi-device expansion

The direct ChatGPT Web milestone is complete only when:

- the local Control Center is green;
- tunnel `/readyz` is green;
- the custom app is visible in ChatGPT Web;
- ChatGPT itself calls `chatgpt_web_status` and receives `directControlPathVerified: true`;
- controlled read/write/execute tests pass inside an authorized workspace;
- audit shows the authenticated remote principal;
- no inbound workstation port is exposed;
- full-control remains off unless explicitly granted by the owner.

See [ChatGPT Web control — end-to-end acceptance](CHATGPT_WEB_CONTROL.md) for the acceptance checklist used before plugin-first multi-device work begins.

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
