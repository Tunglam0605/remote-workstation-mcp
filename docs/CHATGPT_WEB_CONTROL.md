# ChatGPT Web control — end-to-end acceptance

This document defines the completion boundary for the direct ChatGPT Web control path before multi-device Hub/pairing work begins.

## Supported architecture

```text
ChatGPT Web custom MCP app
        |
OpenAI Secure MCP Tunnel
        |
outbound tunnel-client
        |
bearer-authenticated loopback MCP
        |
Remote Workstation MCP
        |
owner-authorized files / Git / processes / SSH / LSP
```

The workstation never opens an inbound public port. The local MCP stays bound to `127.0.0.1` and is authenticated with an ephemeral bearer injected by the tunnel supervisor.

## Workstation-side completion criteria

The local Setup & Control Center must show:

- MCP healthy;
- HTTP auth `bearer`;
- tunnel `READY`;
- start-at-logon enabled when persistent use is desired;
- authorized workspace configured;
- restricted OpenAI tunnel runtime key stored with Windows DPAPI when persistence is enabled.

When these conditions are green, the workstation side is complete.

## ChatGPT-side setup

ChatGPT cannot connect directly to a localhost MCP server. For a private/on-prem/dev-machine MCP server, use Secure MCP Tunnel and create a custom MCP app in ChatGPT Web.

In an eligible ChatGPT workspace:

1. enable Developer Mode according to workspace policy;
2. create a custom app;
3. choose the Secure MCP Tunnel connection path;
4. select/paste the workstation Tunnel ID;
5. review the exposed tools and publish/enable the app for the intended workspace users.

OpenAI product entitlement and workspace administration are independent of this repository. Full custom MCP write/modify support is currently documented for ChatGPT Business, Enterprise and Edu on web. Pro has more limited developer-mode MCP support; Plus should not be assumed to support this full write-capable custom-app flow.

## First verification prompt

After the custom app is added, start with:

> Use Remote Workstation and call `chatgpt_web_status`. Do not modify anything yet. Report whether the authenticated control path is verified, the effective scopes, policy mode and authorized workspace names.

A successful tunnel-backed call should report:

```text
ok: true
chatgptWeb.authenticated: true
chatgptWeb.secureTunnelPrincipal: true
chatgptWeb.directControlPathVerified: true
permissions.read: true
```

The default secure-tunnel supervisor also grants `workstation.write` and `workstation.execute`, so those should be true unless the owner intentionally narrowed `RWMCP_HTTP_SCOPES`.

`fullControl` must remain false by default.

## Safe functional acceptance sequence

Run these checks in order:

1. `chatgpt_web_status` — prove authenticated ChatGPT/OpenAI -> tunnel -> workstation path.
2. `workspace_list` — confirm only owner-authorized workspaces are visible.
3. `git_status` or `fs_read` — confirm read path.
4. create a disposable test file with `fs_write`, then read it back — confirm write path.
5. run an owner-allowlisted harmless process/task — confirm execute path.
6. delete/revert the disposable test artifact through an allowed typed operation or manually if no delete tool is enabled.

Do not enable raw shell or host filesystem merely to pass acceptance. Those remain separate full-control gates and leases.

## Acceptance result

The direct ChatGPT Web control milestone is complete only when all of the following are true:

- local runtime health is green;
- Secure MCP Tunnel readiness is green;
- the custom app is visible in ChatGPT Web;
- `chatgpt_web_status` reports `directControlPathVerified: true` from ChatGPT itself;
- read, controlled write and controlled execute tests pass inside an authorized workspace;
- audit entries identify the authenticated ChatGPT/OpenAI tunnel principal;
- no inbound workstation port is exposed;
- full-control capabilities remain disabled unless the owner explicitly grants them.

Only after this direct path is accepted should the project expand into plugin-first multi-device Hub/pairing mode.
