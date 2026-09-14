# Install Remote Workstation as a ChatGPT plugin

Remote Workstation MCP v0.6 packages the workstation runtime as an OpenAI Agent Plugin for local/repo marketplace distribution.

## Supported install model

The current plugin is designed for the ChatGPT desktop/Codex local environment:

```text
ChatGPT desktop / Codex
        |
   installed plugin
        |
 http://127.0.0.1:8765/mcp
        |
 Remote Workstation MCP
        |
 owner policy / audit / workspaces / SSH
```

The MCP endpoint remains loopback-only. Installing the plugin does not publish the workstation to the Internet.

## 1. Install the workstation runtime

Requirements:

- Linux/Ubuntu recommended
- Node.js 22+
- npm
- Git
- OpenSSH client when SSH tools are required

Install a stable release:

```bash
git clone https://github.com/Tunglam0605/remote-workstation-mcp.git
cd remote-workstation-mcp
git checkout v0.6.0
npm run install:user
```

Run diagnostics:

```bash
npm run doctor
```

Verify health:

```bash
curl -fsS http://127.0.0.1:8765/healthz
```

The response must report `ok: true` and version `0.6.0` before plugin testing.

## 2. Add the repository marketplace

The repository contains:

```text
.agents/plugins/marketplace.json
```

Add the stable release as a marketplace source:

```bash
codex plugin marketplace add Tunglam0605/remote-workstation-mcp --ref v0.6.0
```

For development only, track `main` instead:

```bash
codex plugin marketplace add Tunglam0605/remote-workstation-mcp --ref main
```

Inspect configured sources:

```bash
codex plugin marketplace list
```

Refresh a tracked marketplace:

```bash
codex plugin marketplace upgrade tunglam-remote-workstation
```

or refresh all configured marketplaces:

```bash
codex plugin marketplace upgrade
```

## 3. Install in ChatGPT desktop

Restart the ChatGPT desktop app after adding the marketplace. Open the **Plugins Directory**, select marketplace **TungLam Remote Workstation**, open **Remote Workstation**, and choose **Install**.

The installed package includes:

```text
plugin.json
mcp.json
skills/workstation-operator/SKILL.md
.codex-plugin/plugin.json
.mcp.json
```

The portable `mcp.json` maps the plugin to:

```text
http://127.0.0.1:8765/mcp
```

If the plugin card is visible but tools are unavailable, verify the workstation service first:

```bash
systemctl --user status remote-workstation-mcp.service
curl -fsS http://127.0.0.1:8765/healthz
npm run doctor
```

## 4. First safe tests

Start with read-only discovery:

```text
Check my Remote Workstation health and list the workspaces I authorized.
```

Then inspect a repository:

```text
Inspect the project in my authorized workspace, show Git status, and explain the project structure. Do not modify anything yet.
```

Then test a controlled edit/build loop:

```text
Find the current build error, make the smallest safe fix, run the configured test/build task, and show the Git diff.
```

Keep host-level shell and filesystem gates disabled during initial validation.

## 5. Permission model

Plugin installation does not grant unrestricted machine access.

Normal access is constrained by local `policy.yaml`, workspace roots, executable allowlists, SSH host policy, path protection, and audit logging.

Optional host filesystem or raw shell tools additionally require both:

1. the corresponding local `fullControl` policy gate; and
2. a non-expired permission lease created locally by the owner.

The AI does not have an MCP tool to grant or extend its own lease.

## 6. Version behavior

There are two related update paths:

### Workstation runtime

The managed runtime checks GitHub Releases. Default update mode is `notify`.

```bash
node ~/.local/share/remote-workstation-mcp/current/scripts/update-user.mjs --check
```

### Plugin marketplace snapshot

Refresh the plugin marketplace separately:

```bash
codex plugin marketplace upgrade
```

A marketplace pinned with `--ref v0.6.0` remains pinned until you replace or re-add that source. A marketplace following `main` can be refreshed to newer repository state.

For reproducible community installs, prefer a release tag. For development, use `main`.

## 7. ChatGPT web and public Plugin Directory

A repo/local marketplace and a universal public plugin are different distribution models.

The current local plugin talks to `127.0.0.1`, which is appropriate for the desktop environment but is not reachable from ChatGPT running in the cloud.

To make Remote Workstation installable from the universal public Plugin Directory and usable from ChatGPT web, the project needs one of these supported connection models:

- a remote HTTPS MCP endpoint with secure per-user workstation pairing/tunneling; or
- an OpenAI-registered MCP app mapping backed by a supported secure tunnel/connection mechanism.

A public endpoint must never directly expose the workstation service or bypass its local policy engine. The intended future model is:

```text
ChatGPT web
    |
public registered plugin/app
    |
secure authenticated relay/tunnel
    |
outbound workstation connection
    |
Remote Workstation MCP
    |
local owner policy
```

Public submission also requires OpenAI review through the plugin submission process. The v0.6 local/repo plugin packaging is the foundation for that later distribution stage.

## 8. Remove the marketplace/plugin

Inspect marketplace names:

```bash
codex plugin marketplace list
```

Remove the repository marketplace when no longer needed:

```bash
codex plugin marketplace remove tunglam-remote-workstation
```

To remove the local workstation runtime while preserving config/audit data:

```bash
npm run uninstall:user
```

Destructive removal of local runtime data/config requires the explicit purge flags documented in `docs/OPERATIONS.md`.
