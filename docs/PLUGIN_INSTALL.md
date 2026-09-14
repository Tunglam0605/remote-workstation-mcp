# Install Remote Workstation as a ChatGPT/Codex plugin

Remote Workstation MCP v0.7.2 ships both the workstation MCP runtime and an OpenAI Agent Plugin / Codex-compatible repository package, plus a dedicated ChatGPT Web custom-app path through OpenAI Secure MCP Tunnel.

## Three layers to keep separate

1. **Workstation runtime** — the local MCP server, owner policy, audit, Git/LSP/process/SSH adapters.
2. **Portable plugin package** — repository metadata for local/plugin-compatible clients such as Codex.
3. **ChatGPT Web custom app** — a cloud-hosted ChatGPT connection to the private workstation through Secure MCP Tunnel.

The portable `plugin.json` is not published as an unauthenticated public workstation endpoint. ChatGPT Web reaches the workstation through the tunnel layer.

## 1. Install the workstation runtime

### Windows — recommended new-machine path

```powershell
cd "$HOME\Documents"
git clone https://github.com/Tunglam0605/remote-workstation-mcp.git
cd remote-workstation-mcp
git checkout v0.7.2
npm run setup:windows
npm run setup:web:windows
```

Use the local Setup Console to select a free MCP loopback port, authorize the initial workspace, configure the OpenAI tunnel, install/verify `tunnel-client`, and optionally store the runtime API key with Windows DPAPI.

After setup:

```powershell
npm run start:windows
```

or for ChatGPT/OpenAI cloud access:

```powershell
npm run start:openai:windows
```

### Linux managed runtime

```bash
git clone https://github.com/Tunglam0605/remote-workstation-mcp.git
cd remote-workstation-mcp
git checkout v0.7.2
npm run install:user
npm run doctor
```

## 2. Local/repo marketplace install

The repository contains `.agents/plugins/marketplace.json` and the portable package under `plugins/remote-workstation/`.

Add a reproducible release snapshot:

```bash
codex plugin marketplace add Tunglam0605/remote-workstation-mcp --ref v0.7.2
codex plugin marketplace list
```

For development only, follow `main`:

```bash
codex plugin marketplace add Tunglam0605/remote-workstation-mcp --ref main
```

The portable/compatibility MCP mapping intentionally targets:

```text
http://127.0.0.1:8765/mcp
```

This static mapping is for local compatibility. If that port is already occupied, either customize the local client mapping or use the Secure MCP Tunnel path, which follows the configured runtime port dynamically.

## 3. ChatGPT Web custom app through Secure MCP Tunnel

A cloud-hosted ChatGPT session cannot directly reach workstation loopback. Start the configured tunnel path:

```powershell
npm run start:openai:windows
```

The runtime API-key principal needs Tunnels **Read** + **Use**. The supervisor forces bearer authentication on the local MCP leg, creates an ephemeral workstation bearer by default, injects it into tunnel runtime/discovery headers, and does not forward the OpenAI runtime API key into the MCP child process.

After `tunnel-client` reports `Readyz: PASS`, create the ChatGPT custom app in an eligible workspace:

1. enable Developer Mode according to workspace policy;
2. open ChatGPT Apps/custom app settings;
3. create a custom app;
4. choose **Connection: Tunnel**;
5. select the authorized tunnel or paste its `tunnel_...` ID;
6. review discovered tools before wider workspace publication.

As of September 2026, OpenAI documents full custom MCP write/modify apps on ChatGPT Web for Business, Enterprise and Edu. Repository packaging and tunnel readiness can be completed independently of that account/workspace entitlement.

See [ChatGPT Web](CHATGPT_WEB.md) and [OpenAI Secure MCP Tunnel](OPENAI_SECURE_TUNNEL.md).

## 4. First safe tests

Start with a bounded read request:

```text
Check my Remote Workstation health and list the workspaces I authorized.
```

Then inspect a repository without modifying it:

```text
Inspect the project in my authorized workspace, show Git status, and explain the project structure. Do not modify anything yet.
```

For code navigation, prefer the semantic tools when an owner-configured language server is available. Then test a controlled edit/build loop:

```text
Find the current build error, make the smallest safe fix, run the configured test/build task, and show the Git diff.
```

Keep raw shell and host-filesystem gates disabled during initial validation.

## 5. Permission model

Plugin installation or tunnel connectivity does **not** grant unrestricted machine access. Normal access remains constrained by local `policy.yaml`, authorized workspace roots, executable allowlists, SSH host policy, path protection, authenticated scopes, principal ownership, and audit logging.

Host filesystem or raw shell access additionally requires all of these at the same time:

1. authenticated `workstation.full_control` scope when HTTP authentication is in use;
2. the corresponding local `fullControl` feature gate;
3. a non-expired, owner-created permission lease bound to the matching client/principal profile.

The AI has no MCP tool to create or extend its own lease.

## 6. Version behavior

Runtime updates and repository marketplace snapshots are separate distribution concerns. Prefer release tags for reproducible community installs and `main` only for development.

```bash
node scripts/update-user.mjs --check
codex plugin marketplace upgrade
```

## 7. Public directory / product availability

Repository packaging, Secure MCP Tunnel reachability, ChatGPT custom-app attachment, and universal public directory publication are separate layers. v0.7.2 completes the owner-local onboarding and workstation-side secure connection path; any public Plugin Directory/App publication still depends on OpenAI's current registration/review flow and account/workspace eligibility.

The project never treats public publication as permission to bypass local policy or expose a raw workstation listener.

## 8. Removal

Remove a configured repository marketplace with:

```bash
codex plugin marketplace remove tunglam-remote-workstation
```

Remove the Linux managed runtime while preserving local config/audit data with:

```bash
npm run uninstall:user
```

On Windows, remove persisted Setup Console state only when you intentionally want to forget the workstation setup:

```powershell
Remove-Item "$env:LOCALAPPDATA\RemoteWorkstationMCP" -Recurse -Force
```

That command deletes the DPAPI-protected runtime-key blob as well as non-secret persisted settings. It does not delete the repository itself.
