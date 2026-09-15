# ChatGPT Web control - end-to-end acceptance

This checklist verifies the complete Remote Workstation MCP v0.8.1 path from ChatGPT Web to the private workstation.

## Supported path

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
owner-selected access mode + policy + audit
        |
workstation adapters
```

The workstation MCP remains on loopback. Do not expose the MCP or Control Center ports directly to the Internet.

## Workstation-side prerequisites

The local Control Center should show:

- MCP `HEALTHY`;
- HTTP authentication `bearer`;
- Tunnel `READY`;
- start-at-logon ON for persistent use;
- authorized workspace configured;
- restricted Runtime API key stored with Windows DPAPI when persistence is enabled.

Use a Runtime API key with **Tunnels Read + Use**. Do not use a long-lived Admin API key for the normal tunnel daemon.

## ChatGPT-side prerequisites

In a supported ChatGPT workspace:

1. enable Developer Mode when required;
2. open **Settings -> Apps**;
3. create the **Remote Workstation** custom MCP app;
4. choose the Secure MCP Tunnel connection path;
5. select or paste the same workstation Tunnel ID;
6. review discovered tools before wider publication.

OpenAI product entitlement is independent of workstation health. See [ChatGPT Web custom app setup](CHATGPT_WEB.md) for current plan notes and detailed steps.

## First verification prompt

Start read-only:

> Use Remote Workstation and call `chatgpt_web_status`. Do not modify anything yet. Report whether the authenticated control path is verified, the effective scopes, policy mode and authorized workspace names.

A successful tunnel-backed response should report:

```text
ok: true
chatgptWeb.authenticated: true
chatgptWeb.secureTunnelPrincipal: true
chatgptWeb.directControlPathVerified: true
```

Then call `workspace_list` and confirm only expected owner-authorized workspaces are visible.

## Safe functional acceptance sequence

Run these checks in order:

1. `chatgpt_web_status` - prove the authenticated ChatGPT -> tunnel -> workstation path.
2. `workspace_list` - confirm workspace scope.
3. `git_status` or `fs_read` - confirm read access.
4. In Workspace mode, create a disposable file with `fs_write`, then read it back - confirm controlled write access.
5. Run one harmless owner-approved process/task - confirm controlled execute access.
6. Remove or revert the disposable artifact through an allowed typed operation or manually.
7. Check the local audit log and confirm the authenticated tunnel principal is recorded.

Do not switch to Full access just to pass this acceptance test.

## Access-mode expectations

- **Read only**: read verification should pass; write/execute should be blocked.
- **Workspace**: approved read/write/execute inside configured workspaces should pass.
- **Full access**: host filesystem and raw shell become available as the current Windows user when corresponding local gates are enabled.

Full access is not Administrator. Administrator remains a separate local-owner approval plus Windows UAC flow.

## Completion criteria

The direct ChatGPT Web control path is accepted when:

- local MCP health is green;
- Secure MCP Tunnel readiness is green;
- the custom app is visible and usable in ChatGPT Web;
- `chatgpt_web_status` reports `directControlPathVerified: true`;
- expected read/write/execute behavior matches the selected access mode;
- audit identifies the authenticated tunnel principal;
- no inbound workstation port is exposed;
- Administrator execution still requires one-shot local approval and UAC.

Once these checks pass, normal daily use should not require reopening PowerShell or repeating tunnel setup.
