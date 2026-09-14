# Install Remote Workstation as a ChatGPT/Codex plugin

Remote Workstation MCP v0.7.0 ships both the workstation MCP runtime and an OpenAI Agent Plugin / Codex-compatible repository package.

## Two connection models

Local plugin/client path:

```text
ChatGPT desktop / Codex / local MCP client
                 |
          installed plugin
                 |
      http://127.0.0.1:8765/mcp
                 |
       Remote Workstation MCP
```

ChatGPT/cloud path:

```text
ChatGPT / OpenAI-hosted MCP consumer
                 |
         Secure MCP Tunnel
                 |
         tunnel-client
                 |
      http://127.0.0.1:8765/mcp
                 |
       Remote Workstation MCP
```

Both models keep the workstation MCP loopback-only. Do not expose port `8765` through router forwarding or an unauthenticated public reverse proxy.

## 1. Install the workstation runtime

### Windows

```powershell
cd "$HOME\Documents"
git clone https://github.com/Tunglam0605/remote-workstation-mcp.git
cd remote-workstation-mcp
git checkout v0.7.0
npm run setup:windows
npm run start:windows
```

### Linux managed runtime

```bash
git clone https://github.com/Tunglam0605/remote-workstation-mcp.git
cd remote-workstation-mcp
git checkout v0.7.0
npm run install:user
npm run doctor
```

Verify health before client/plugin testing:

```text
http://127.0.0.1:8765/healthz
```

The response must report `ok: true` and version `0.7.0`.

## 2. Local/repo marketplace install

The repository contains `.agents/plugins/marketplace.json` and the portable package under `plugins/remote-workstation/`.

Add a reproducible release snapshot:

```bash
codex plugin marketplace add Tunglam0605/remote-workstation-mcp --ref v0.7.0
codex plugin marketplace list
```

For development only, follow `main`:

```bash
codex plugin marketplace add Tunglam0605/remote-workstation-mcp --ref main
```

The portable/compatibility MCP mappings intentionally target:

```text
http://127.0.0.1:8765/mcp
```

so this path is appropriate only when the client can reach the workstation loopback endpoint.

## 3. ChatGPT/cloud through OpenAI Secure MCP Tunnel

A cloud-hosted ChatGPT session cannot directly reach workstation loopback. v0.7.0 supports OpenAI Secure MCP Tunnel as an outbound connection provider.

On Windows:

```powershell
npm run openai:tunnel:install:windows
$env:CONTROL_PLANE_TUNNEL_ID = "tunnel_0123456789abcdef0123456789abcdef"
$env:CONTROL_PLANE_API_KEY = "<runtime-api-key>"
npm run start:openai:windows
```

Create/select the tunnel and runtime key in OpenAI Platform first. The runtime-key principal needs Tunnels **Read** + **Use**. After `tunnel-client` reports ready, configure/use the corresponding connector in the supported ChatGPT/OpenAI product surface.

The supervisor forces bearer authentication on the local MCP leg, creates an ephemeral workstation bearer by default, injects it into tunnel runtime/discovery headers, and does not forward the OpenAI runtime API key into the MCP child process.

See [OpenAI Secure MCP Tunnel](OPENAI_SECURE_TUNNEL.md) for the full trust boundary and current setup flow.

## 4. First safe tests

Start read-only:

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

Runtime updates and repository marketplace snapshots are separate distribution concerns. The managed runtime can check GitHub Releases, while a marketplace pinned with `--ref v0.7.0` remains pinned until you replace or re-add it.

```bash
node scripts/update-user.mjs --check
codex plugin marketplace upgrade
```

Prefer release tags for community/reproducible installs and `main` only for development.

## 7. Public directory / product availability

Repository packaging, Secure MCP Tunnel reachability, and universal public directory publication are separate layers. v0.7.0 completes the workstation-side secure connection path; any public Plugin Directory/App publication still depends on the currently supported OpenAI registration/review flow and account/workspace eligibility.

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

See `docs/OPERATIONS.md` for destructive purge options.
