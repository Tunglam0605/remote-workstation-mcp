# ChatGPT Web custom app / MCP connection

Remote Workstation MCP is designed so ChatGPT Web can be a **first-class controller**. Codex, Claude, OpenHands, or another coding agent is optional; none is required as a middle hop.

The workstation side uses OpenAI Secure MCP Tunnel so the MCP server remains on loopback and no inbound Internet-facing port is required.

## Current ChatGPT product requirement

As of September 2026, OpenAI documents full MCP support, including write/modify tools and Developer Mode custom apps, for ChatGPT **Business, Enterprise, and Edu** on the web. Product availability and UI labels can change independently of this repository.

Official references:

- Developer Mode and MCP apps: `https://help.openai.com/en/articles/12584461`
- ChatGPT connector/app settings: `https://chatgpt.com/#settings/Connectors`
- OpenAI Secure MCP Tunnel: `https://github.com/openai/tunnel-client`

A tunnel can be configured and validated even when the current ChatGPT account/workspace is not entitled to attach a custom write-capable MCP app. That product entitlement is separate from workstation/tunnel health.

## Workstation setup

On a new Windows machine:

```powershell
npm run setup:windows
npm run setup:web:windows
```

In the Setup Console:

1. choose an unused MCP loopback port;
2. choose the authorized workspace root;
3. paste the existing OpenAI tunnel ID or create a tunnel in Platform Tunnels;
4. set the organization ID when the tunnel is organization-scoped;
5. create a restricted runtime API key with **Tunnels Read + Use**;
6. save the runtime key with Windows DPAPI if persistent unattended starts are desired;
7. install/verify the official `tunnel-client`;
8. stop the Setup Console after onboarding.

Start the connection:

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

For an eligible ChatGPT workspace:

1. enable Developer Mode according to workspace policy;
2. open ChatGPT Apps / custom app settings;
3. create a custom app;
4. choose **Connection: Tunnel**;
5. select the authorized tunnel or paste its `tunnel_...` ID;
6. complete discovery while `npm run start:openai:windows` remains running;
7. review the discovered tools before enabling the app for additional workspace users.

The tunnel must include the target ChatGPT workspace scope to appear in the connector picker when workspace scoping is required.

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

The default tunnel principal has:

```text
workstation.read,workstation.write,workstation.execute
```

`workstation.full_control` is intentionally not included by default. Host-wide shell/filesystem actions still require all of the following: the full-control scope, an active client-bound owner lease, and the relevant local dangerous-feature gate.

## Plugin package vs ChatGPT custom app

The repository includes a portable Agent Plugin/Codex-compatible package under `plugins/remote-workstation/`. That package is useful for local/plugin-compatible clients and distribution metadata.

ChatGPT Web custom MCP attachment is not implemented by exposing the repository's local `plugin.json` to the Internet. For ChatGPT Web, the supported private-workstation route is the Secure MCP Tunnel plus ChatGPT custom app/connector setup described above.

This distinction is intentional: portable plugin packaging and remote ChatGPT reachability are separate layers.
