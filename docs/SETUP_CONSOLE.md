# Local Setup Console

Remote Workstation MCP v0.7.2 adds an owner-operated web setup flow for bringing a new workstation online without hand-editing environment variables for every start.

The Setup Console is **not** an MCP tool and is never exposed through the OpenAI tunnel. It binds only to `127.0.0.1`, uses an ephemeral setup token, rejects non-loopback clients, applies a same-origin check, sends `Cache-Control: no-store`, and is intended to be stopped after onboarding.

## Windows first-use flow

```powershell
cd "$HOME\Documents"
git clone https://github.com/Tunglam0605/remote-workstation-mcp.git
cd remote-workstation-mcp
git checkout v0.7.2
npm run setup:windows
npm run setup:web:windows
```

`setup:windows` validates Node.js/npm/Git, installs dependencies, runs typecheck/tests/build/plugin validation, and creates safe local policy/hosts files when they do not already exist.

`setup:web:windows` opens the local Setup Console. Its default bind port is `8684`; if that port is occupied it searches the next loopback ports. Override the preferred setup port with `RWMCP_SETUP_PORT`.

## What the console configures

The web flow can configure:

- MCP loopback port (`RWMCP_PORT` equivalent);
- authorized workspace root for a new default policy;
- OpenAI Secure MCP Tunnel ID;
- OpenAI organization ID;
- managed Cloudflare runtime opt-in/out;
- official OpenAI `tunnel-client` installation on Windows;
- OpenAI runtime API key storage using the current Windows user's DPAPI protection.

Non-secret settings are stored outside the repository at:

```text
%LOCALAPPDATA%\RemoteWorkstationMCP\settings.json
```

The OpenAI runtime API key is not stored in that JSON file. When the owner chooses secure persistence on Windows, an encrypted DPAPI blob is stored under:

```text
%LOCALAPPDATA%\RemoteWorkstationMCP\secrets\openai-runtime-api-key.dpapi
```

The blob is decryptable only in the Windows user context that created it. The Setup Console never reads the decrypted key back into the browser after saving it.

## Precedence

Explicit process environment variables remain authoritative. The Windows launchers only import persisted setup values when the corresponding environment variable is absent.

That means temporary overrides remain straightforward:

```powershell
$env:RWMCP_PORT = "9000"
npm run start:windows
```

and:

```powershell
$env:CONTROL_PLANE_TUNNEL_ID = "tunnel_0123456789abcdef0123456789abcdef"
$env:CONTROL_PLANE_API_KEY = "<session-only-runtime-key>"
npm run start:openai:windows
```

## Existing owner policy is preserved

The Setup Console creates a safe default `config/policy.yaml` only when the policy file does not already exist. It never overwrites an existing owner policy. The same rule applies to `config/hosts.yaml`.

For an existing installation, changing the workspace path in `settings.json` does not silently rewrite a custom policy. Edit the owner policy explicitly when changing already-authorized workspaces.

## Starting after setup

Local-only MCP:

```powershell
npm run start:windows
```

ChatGPT/OpenAI tunnel path:

```powershell
npm run start:openai:windows
```

The OpenAI launcher loads saved tunnel/org/port settings and, when present, decrypts the DPAPI-protected runtime API key for the current Windows user. The key is still stripped from the MCP child process; it is provided only to `tunnel-client`.

## Security boundary

The Setup Console deliberately does not provide controls for enabling raw shell, host-wide filesystem access, sudo/Administrator execution, or granting permission leases. Those remain explicit local-owner security operations outside the browser onboarding flow.

Do not bind the Setup Console to a LAN address, publish it through a reverse proxy, or expose it through the Secure MCP Tunnel.
