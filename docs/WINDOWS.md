# Windows runtime

Remote Workstation MCP v0.7.2 validates the core runtime on both Ubuntu and Windows and includes a loopback-only Setup Console plus the outbound OpenAI Secure MCP Tunnel path for ChatGPT/cloud access.

## Requirements

- Windows 10/11
- Node.js 22+
- npm
- Git
- OpenSSH client when SSH tools are needed
- PowerShell 5.1+ or PowerShell 7+

## Recommended new-machine setup

```powershell
cd "$HOME\Documents"
git clone https://github.com/Tunglam0605/remote-workstation-mcp.git
cd remote-workstation-mcp
git checkout v0.7.2
npm run setup:windows
npm run setup:web:windows
```

`setup:windows` installs dependencies, runs typecheck/tests/build/plugin validation, and creates a safe default policy/SSH hosts file only when they do not already exist.

`setup:web:windows` opens the owner-local Setup Console on `127.0.0.1`. The UI lets the owner choose a loopback MCP port, workspace root, OpenAI tunnel/org values, install the verified official tunnel-client, and optionally store the OpenAI runtime API key with Windows DPAPI.

The default workspace is:

```text
%USERPROFILE%\Documents\RemoteWorkspaces
```

Non-secret setup state is stored outside the repo:

```text
%LOCALAPPDATA%\RemoteWorkstationMCP\settings.json
```

The optional runtime-key secret is stored separately as a current-user DPAPI blob:

```text
%LOCALAPPDATA%\RemoteWorkstationMCP\secrets\openai-runtime-api-key.dpapi
```

See [Local Setup Console](SETUP_CONSOLE.md).

## Local-only start

After setup:

```powershell
npm run start:windows
```

The launcher imports the persisted MCP port when `RWMCP_PORT` is not already set. Explicit environment variables always override saved settings.

Example output for a workstation configured on port `8683`:

```text
MCP:    http://127.0.0.1:8683/mcp
Health: http://127.0.0.1:8683/healthz
```

Verify from a second PowerShell window:

```powershell
Invoke-RestMethod http://127.0.0.1:8683/healthz
```

Expected fields include:

```text
ok      : True
version : 0.7.2
mode    : workspace
```

A one-session override still works:

```powershell
$env:RWMCP_PORT = "9000"
npm run start:windows
```

## ChatGPT/cloud start through OpenAI Secure MCP Tunnel

Do **not** expose the local MCP port to the Internet.

The Setup Console can install the pinned official OpenAI tunnel-client. The CLI equivalent is:

```powershell
npm run openai:tunnel:install:windows
```

After tunnel settings have been saved in the Setup Console, start with:

```powershell
npm run start:openai:windows
```

The launcher reuses saved MCP port, tunnel ID, organization ID, Cloudflare preference, and DPAPI-protected runtime API key unless an explicit environment variable overrides them.

The supervisor keeps MCP bound to loopback, enables bearer authentication, gives the tunnel principal read/write/execute scopes by default, runs `tunnel-client doctor`, starts the tunnel, and waits for `/readyz` before reporting success. The local MCP bearer is generated per run and is not persisted in the tunnel profile. The OpenAI runtime API key is not forwarded into the MCP child process.

Managed Cloudflare runtime material remains optional and disabled by default. Only set:

```powershell
$env:CLOUDFLARED_MANAGED = "true"
```

when the selected tunnel is known to have managed Cloudflare runtime material provisioned.

See [ChatGPT Web](CHATGPT_WEB.md) and [OpenAI Secure MCP Tunnel](OPENAI_SECURE_TUNNEL.md) for the complete connection path.

## Windows security notes

The Setup Console binds only to loopback, requires an ephemeral setup token for API calls, rejects cross-origin browser requests, and sends no-store responses. Stop it after onboarding.

The browser setup flow never exposes controls to enable raw shell, host-wide filesystem access, Administrator execution, or permission leases. Those remain explicit local-owner security operations.

Windows normally restricts creation of symbolic links unless Developer Mode or elevated privileges are enabled. The project's security regression tests use directory junctions on Windows so path-escape protections can be validated without requiring Administrator privileges.

The raw-shell adapter uses PowerShell on Windows and Bash on POSIX systems. Host-level raw shell and host filesystem capabilities remain disabled by default and still require local policy gates plus an active owner-issued permission lease.

## Process execution

Prefer native executables (`git.exe`, `node.exe`, `python.exe`, `cmake.exe`, `ninja.exe`) in Windows process allowlists. Windows `.cmd`/`.bat` wrapper execution is intentionally not treated as equivalent to native executable execution because routing arbitrary arguments through `cmd.exe` changes the shell-injection threat model.

Managed processes support bounded pipe-backed stdin through `process_write` and `process_close_stdin`. This is useful for REPL-like tools and persistent engineering helpers, but it is not a PTY/ConPTY terminal emulator. A true terminal adapter remains a separate future layer.

## Semantic code intelligence

v0.7.2 supports owner-configured language servers for definition, references, hover, document symbols, and diagnostics. Language servers remain executable-allowlisted and workspace-bounded. Configure them under the `lsp` section of `config/policy.yaml`; see [LSP](LSP.md).
