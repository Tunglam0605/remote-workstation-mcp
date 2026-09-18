# ChatGPT Web custom MCP app setup

Remote Workstation MCP is designed so ChatGPT Web can connect directly to a private workstation through OpenAI Secure MCP Tunnel. No inbound workstation port needs to be exposed to the public Internet.

OpenAI currently calls this integration a **custom MCP app**. Older product UI or older documentation may use the terms connector or plugin.

## Availability

OpenAI product availability is separate from RWMCP itself. As of September 2026, OpenAI documents full custom MCP support, including write/modify actions, on ChatGPT Web for Business, Enterprise and Edu workspaces. Pro has more limited developer-mode MCP support. Product UI, workspace policy and entitlements can change independently of this repository.

Current OpenAI references:

- Developer Mode and MCP apps: `https://help.openai.com/en/articles/12584461`
- ChatGPT app settings: `https://chatgpt.com/#settings/Connectors`
- OpenAI Secure MCP Tunnel client: `https://github.com/openai/tunnel-client`

## What you need

Before creating the ChatGPT app, the workstation side should already have:

- RWMCP v0.8.5 installed;
- one OpenAI Secure MCP Tunnel ID;
- one restricted Runtime API key with Tunnels Read + Use;
- `tunnel-client` installed by the RWMCP managed installer;
- the local Control Center showing the tunnel as READY.

## Step 1 - Create or select the tunnel

Open OpenAI Platform Tunnels:

`https://platform.openai.com/settings/organization/tunnels`

Create a tunnel for the workstation or select an existing tunnel that is intentionally assigned to it.

Copy the tunnel ID. It has the form:

```text
tunnel_<32-hex-characters>
```

Recommended practice is one production workstation per tunnel so revocation and audit remain clear.

Permission split:

- runtime users: **Tunnels Read + Use**;
- tunnel managers: **Tunnels Read + Manage**;
- a manager who also runs the tunnel needs Use as well.

When a tunnel is scoped to a ChatGPT workspace, ensure the intended workspace is included so the tunnel can appear in the app/tunnel picker.

## Step 2 - Create the Runtime API key

Open OpenAI Platform Runtime API keys:

`https://platform.openai.com/settings/organization/api-keys`

Create a **Restricted** key and enable only the permissions required for the runtime:

```text
Tunnels: Read
Tunnels: Use
```

Copy the key when it is shown. RWMCP refers to this value as the Runtime API key / `CONTROL_PLANE_API_KEY`.

Do not substitute an OpenAI Admin API key for the long-lived runtime daemon. Admin keys are intended for tunnel administration such as create/list/update/delete and should not be placed into the normal RWMCP runtime configuration.

## Step 3 - Configure RWMCP

Open the local Control Center:

`http://127.0.0.1:8684`

Enter:

- authorized workspace root;
- Tunnel ID;
- Organization ID when applicable;
- restricted Runtime API key;
- keep Windows DPAPI persistence enabled for normal managed Windows use.

Choose **Prepare this PC for ChatGPT**.

The managed wizard:

1. saves non-secret setup values;
2. stores the runtime key with current-user Windows DPAPI;
3. verifies the pinned `tunnel-client`;
4. starts RWMCP with bearer authentication;
5. starts the Secure MCP Tunnel;
6. waits for MCP health and tunnel `/readyz`;
7. enables current-user start-at-logon.

A ready v0.8.5 workstation should show:

```text
MCP          HEALTHY
Tunnel       ONLINE
Auth         bearer
Start logon  ON
```

The runtime also exposes `connectionState` as `ONLINE`, `RECONNECTING`, or `OFFLINE`.

## v0.8.4 local recovery when the app cannot connect

A ChatGPT app can become unreachable because the runtime API key expired/was revoked, the tunnel is offline, or the app was removed from ChatGPT. None of those conditions should prevent local recovery.

On the workstation itself open:

```text
http://127.0.0.1:8684
```

The Control Center should continue to show **Control Center: ONLINE** even when MCP or Tunnel is offline. In **Settings -> OpenAI connection**, keep or replace the Tunnel ID as appropriate, paste the replacement restricted Runtime API key, choose **Test credentials**, then **Save & reconnect**.

Do not create a new tunnel merely because a runtime key was rotated. Reuse the existing Tunnel ID unless the tunnel itself was intentionally replaced/deleted.

## Step 4 - Enable Developer Mode in ChatGPT when required

The exact path depends on the ChatGPT workspace and plan. Current OpenAI documentation places Developer Mode under Apps settings.

Typical paths include:

```text
User Settings -> Apps -> Advanced settings -> Developer mode
```

or, for workspace administrators/owners:

```text
Workspace settings -> Apps -> Create
```

Enterprise/Edu workspaces may additionally use RBAC to control who can use Developer Mode or access a published custom app.

## v0.8.3 Direct Multi-Node refresh

If this app was already connected before upgrading, start a fresh ChatGPT chat or reconnect the custom MCP app once after the workstation reaches v0.8.3 so ChatGPT refreshes the MCP schema.

Each workstation should use its own Tunnel ID and its own clearly named custom MCP app, for example:

- `Remote Workstation - TungLam Laptop`
- `Remote Workstation - Ubuntu Vision PC`
- `Remote Workstation - Office PC 65`

Use `workstation_identity` or `chatgpt_web_status` to confirm which workstation an app controls. When multiple Remote Workstation apps are selected for one message, ChatGPT can target each machine directly; routine multi-device work no longer needs `device_exec` or an SSH gateway.

The legacy `device_list`, `device_probe`, `device_exec`, `ssh_hosts`, `ssh_probe`, and `ssh_exec` tools remain available for bootstrap and explicit gateway workflows.

## Step 5 - Create the Remote Workstation app

While the workstation tunnel is READY:

1. Open ChatGPT Web.
2. Open **Settings -> Apps**.
3. Choose **Create** / **Add custom app**.
4. Set the name to the value recommended by `workstation_identity` / Control Center, for example **Remote Workstation - TungLam Laptop**.
5. Choose **Tunnel** as the connection method.
6. Select the provisioned tunnel or paste the exact `tunnel_...` ID.
7. Run discovery while the workstation remains online.
8. Review the discovered RWMCP tools.
9. Save/test the app before publishing it to other workspace members.

If the tunnel is not visible, first confirm workspace scoping and the user/role's Tunnels Read + Use permission. A connector/app can look configured in ChatGPT while the workstation runtime is still unavailable, so always verify tunnel READY before troubleshooting ChatGPT discovery.

### Refreshing actions after an RWMCP schema upgrade

RWMCP reports `actionSchemaVersion` through `capabilities_list`. A custom app may keep the action catalog discovered when it was created/refreshed, so opening a new chat is not a substitute for refreshing the app when the action schema version changes.

For v0.12.0, `actionSchemaVersion=2`. Refresh the custom-app actions once after upgrading from an older catalog so ChatGPT discovers `engineering_project_inspect`, `engineering_profile_init`, and `engineering_workflow_*` with the stable v2 envelopes. Future workflow/provider additions that stay on action schema v2 travel through `workflow` + server-validated `parameters` and do not require a new top-level tool definition.

v0.13.x keeps `actionSchemaVersion=2` and `engineeringApiVersion=3`, so an app already refreshed for v0.12 does **not** need another action refresh. The `stm32.deploy_accept` workflow is discovered through the existing `engineering_workflow_*` actions. v0.13.1 changes only Windows recovery-plane lifecycle behavior; v0.13.2 changes only OpenOCD provider discovery/script resolution. Neither changes the ChatGPT action catalog.

After refreshing, verify with `capabilities_list` and confirm both `actionSchemaVersion` and `engineeringApiVersion` before relying on the high-level Engineering Workflow Engine.

## Step 6 - First safe verification

Start with a read-only verification prompt:

> Use Remote Workstation. Call `chatgpt_web_status` first. Do not modify anything. Report whether the authenticated control path is verified, the effective scopes, policy mode and authorized workspace names.

A successful result should include:

```text
ok: true
chatgptWeb.authenticated: true
chatgptWeb.secureTunnelPrincipal: true
chatgptWeb.directControlPathVerified: true
```

Then verify:

1. `workspace_list`;
2. `git_status` or `fs_read` inside an authorized workspace;
3. only after that, a disposable write/read-back test;
4. one harmless approved process/task if execution is required;
5. the local audit log records the authenticated tunnel principal.

Do not enable Full access merely to make initial discovery work.

## Access and Administrator behavior

ChatGPT app connectivity and workstation authorization are separate layers.

```text
ChatGPT custom MCP app
        -> OpenAI Secure MCP Tunnel
        -> ephemeral local MCP bearer
        -> authenticated workstation scopes
        -> local RWMCP access mode/policy
        -> audit
        -> workstation adapter
```

RWMCP owner modes are:

- Read only;
- Workspace;
- Full access.

Full access only enables host filesystem/raw shell as the current Windows user. It does not grant Administrator.

Administrator remains a one-shot path:

```text
AI admin_request
    -> pending local request
    -> owner reviews exact executable / args / reason
    -> owner selects Allow once
    -> Windows RunAs / UAC
    -> one privileged execution
```

## Common failures

### App cannot discover the workstation

Check in this order:

1. Control Center says MCP HEALTHY.
2. Tunnel says READY.
3. HTTP auth says bearer.
4. Tunnel ID in ChatGPT and RWMCP is identical.
5. Runtime key principal has Tunnels Read + Use.
6. Tunnel is scoped to the intended organization/workspace.
7. The ChatGPT account/workspace currently supports the custom MCP app flow.

### Tunnel exists but does not appear in ChatGPT

Verify the tunnel's workspace association and the current user's tunnel permissions. Newly created tunnel metadata may also take a short time to propagate.

### ChatGPT can read but cannot write

First check the selected RWMCP mode. Read only deliberately blocks writes. Workspace mode permits approved operations only inside configured workspaces. Product/workspace MCP entitlements can also limit available action classes.

### Full access still cannot run Administrator command

Expected. Full access is user-level host control, not elevation. Use the local Administrator approval flow.

## Security notes

- Never paste the runtime API key into README, issues, screenshots, prompts or Git commits.
- Prefer a Restricted Runtime API key with Tunnels Read + Use.
- Do not use an Admin API key for the persistent tunnel daemon.
- Keep the Control Center loopback-only.
- Keep the MCP listener loopback-only.
- Treat each workstation/tunnel as its own revocable security boundary.
- Review discovered tools before publishing a custom app to a workspace.

See also:

- [Windows quick start](QUICKSTART_WINDOWS.md)
- [OpenAI Secure MCP Tunnel](OPENAI_SECURE_TUNNEL.md)
- [ChatGPT Web end-to-end acceptance](CHATGPT_WEB_CONTROL.md)
- [Security](SECURITY.md)
