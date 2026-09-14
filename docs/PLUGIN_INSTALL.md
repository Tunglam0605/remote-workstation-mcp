# Install Remote Workstation for ChatGPT/Codex

Remote Workstation MCP v0.7.3 ships three separate layers that should not be conflated:

1. **Workstation runtime** — local MCP server, owner policy, audit, Git/LSP/process/SSH adapters.
2. **Portable plugin package** — repository metadata for local/plugin-compatible clients such as Codex.
3. **ChatGPT Web custom app** — cloud-hosted ChatGPT reaching the private workstation through OpenAI Secure MCP Tunnel.

The portable plugin manifest is not an unauthenticated public workstation endpoint. ChatGPT Web reaches the workstation through the tunnel layer.

## 1. Install the workstation runtime

### Windows managed release — recommended

```powershell
$installer = Join-Path $env:TEMP 'rwmcp-install.ps1'
Invoke-WebRequest `
  'https://github.com/Tunglam0605/remote-workstation-mcp/releases/latest/download/install-windows.ps1' `
  -OutFile $installer
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File $installer
```

The release installer verifies SHA-256, installs a per-user version slot, preserves stable config/secrets outside the slot, installs the pinned OpenAI tunnel-client and opens the Setup & Control Center.

After onboarding, the stable launcher is:

```powershell
$ctl = "$env:LOCALAPPDATA\RemoteWorkstationMCP\bin\rwmcp.ps1"
& $ctl -Action StartOpenAI
```

### Windows repository development

```powershell
cd "$HOME\Documents"
git clone https://github.com/Tunglam0605/remote-workstation-mcp.git
cd remote-workstation-mcp
git checkout v0.7.3
npm run setup:first-run:windows
```

### Linux managed runtime

```bash
git clone https://github.com/Tunglam0605/remote-workstation-mcp.git
cd remote-workstation-mcp
git checkout v0.7.3
npm run install:user
npm run doctor
```

## 2. Local/repo marketplace install

The repository contains `.agents/plugins/marketplace.json` and the portable package under `plugins/remote-workstation/`.

Add a reproducible release snapshot:

```bash
codex plugin marketplace add Tunglam0605/remote-workstation-mcp --ref v0.7.3
codex plugin marketplace list
```

For development only, follow `main`:

```bash
codex plugin marketplace add Tunglam0605/remote-workstation-mcp --ref main
```

The portable compatibility MCP mapping targets a local loopback endpoint. If the default port is already occupied, customize that local client mapping or use the Secure MCP Tunnel path, which follows the configured workstation port dynamically.

## 3. ChatGPT Web custom app through Secure MCP Tunnel

A cloud-hosted ChatGPT session cannot directly reach workstation loopback. Start the configured tunnel path from the Control Center or stable launcher:

```powershell
& "$env:LOCALAPPDATA\RemoteWorkstationMCP\bin\rwmcp.ps1" -Action StartOpenAI
```

Repository-development equivalent:

```powershell
npm run start:openai:windows
```

The runtime API-key principal needs the OpenAI tunnel permissions required by the selected tunnel. The supervisor forces bearer authentication on the local MCP leg, creates an ephemeral workstation bearer by default, injects it into tunnel runtime/discovery headers, and does not forward the OpenAI runtime API key into the MCP child process.

After tunnel readiness is confirmed, create the ChatGPT custom app in a workspace/account where OpenAI currently enables that feature:

1. enable Developer Mode according to workspace policy;
2. open ChatGPT Apps/custom app settings;
3. create a custom app;
4. choose **Connection: Tunnel**;
5. select the authorized tunnel or paste its `tunnel_...` ID;
6. review discovered tools before wider workspace publication.

Repository packaging, tunnel readiness and ChatGPT product entitlement are independent. A workstation can be completely installed and tunnel-ready even when a particular ChatGPT account does not expose the custom-app UI.

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

For code navigation, prefer semantic tools when an owner-configured language server is available. Then test a controlled edit/build loop:

```text
Find the current build error, make the smallest safe fix, run the configured test/build task, and show the Git diff.
```

Keep raw shell and host-filesystem gates disabled during initial validation.

## 5. Permission model

Plugin installation or tunnel connectivity does **not** grant unrestricted machine access. Normal access remains constrained by local `policy.yaml`, authorized workspace roots, executable allowlists, SSH host policy, path protection, authenticated scopes, principal ownership, and audit logging.

Host filesystem or raw shell access additionally requires all of these at the same time:

1. authenticated `workstation.full_control` scope when HTTP authentication is in use;
2. the corresponding local `fullControl` feature gate;
3. a non-expired owner-created permission lease bound to the matching principal/client profile.

The AI has no MCP tool to create or extend its own lease.

## 6. Windows update and rollback

Managed Windows installations update through the stable launcher:

```powershell
& "$env:LOCALAPPDATA\RemoteWorkstationMCP\bin\rwmcp.ps1" -Action Update
```

Rollback to the previous installed slot:

```powershell
& "$env:LOCALAPPDATA\RemoteWorkstationMCP\bin\rwmcp.ps1" -Action Rollback
```

Owner policy, SSH hosts, settings, audit logs and DPAPI secrets stay outside version slots.

Portable plugin marketplace snapshots are a separate distribution concern. Prefer release tags for reproducibility and `main` only for development.

## 7. Public directory / product availability

Repository packaging, Secure MCP Tunnel reachability, ChatGPT custom-app attachment and any public directory publication are separate layers. Public publication never grants permission to bypass workstation policy or expose a raw workstation listener.

## 8. Removal

Remove a configured repository marketplace with:

```bash
codex plugin marketplace remove tunglam-remote-workstation
```

Remove the Linux managed runtime while preserving local config/audit data with:

```bash
npm run uninstall:user
```

A managed Windows install is intentionally per-user under:

```text
%LOCALAPPDATA%\RemoteWorkstationMCP
```

Stop the runtime and disable start-at-logon before deleting that directory. Deleting it also removes the DPAPI-protected OpenAI runtime-key blob and installed version slots.
