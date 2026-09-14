# Windows runtime

Remote Workstation MCP v0.7.1 validates the core runtime on both Ubuntu and Windows and includes an optional outbound OpenAI Secure MCP Tunnel path for ChatGPT/cloud access.

## Requirements

- Windows 10/11
- Node.js 22+
- npm
- Git
- OpenSSH client when SSH tools are needed
- PowerShell 5.1+ or PowerShell 7+

## Setup

```powershell
cd "$HOME\Documents"
git clone https://github.com/Tunglam0605/remote-workstation-mcp.git
cd remote-workstation-mcp
git checkout v0.7.1
npm run setup:windows
```

The setup script creates a safe default workspace at:

```text
%USERPROFILE%\Documents\RemoteWorkspaces
```

It creates local `config/policy.yaml` and `config/hosts.yaml` only when they do not already exist, then runs typecheck, tests, build, and plugin validation.

## Local-only start

The default loopback port remains `8765`, but `RWMCP_PORT` can select another free port. The Windows launcher prints the actual configured value.

```powershell
$env:RWMCP_PORT = "8683"   # optional example when 8765 is already occupied
npm run start:windows
```

Example output:

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
version : 0.7.1
mode    : workspace
```

To persist a custom port for future PowerShell sessions:

```powershell
[Environment]::SetEnvironmentVariable("RWMCP_PORT", "8683", "User")
```

## ChatGPT/cloud start through OpenAI Secure MCP Tunnel

Do **not** expose the local MCP port to the Internet.

```powershell
npm run openai:tunnel:install:windows
```

Then set the runtime values in the current PowerShell session:

```powershell
$env:RWMCP_PORT = "8683"
$env:CONTROL_PLANE_TUNNEL_ID = "tunnel_0123456789abcdef0123456789abcdef"
$env:CONTROL_PLANE_ORGANIZATION_ID = "org_example"
$env:CONTROL_PLANE_API_KEY = "<runtime-api-key>"
npm run start:openai:windows
```

The supervisor keeps MCP bound to loopback, enables bearer authentication, gives the tunnel principal read/write/execute scopes by default, runs `tunnel-client doctor`, starts the tunnel, and waits for `/readyz` before reporting success. The local MCP bearer is generated per run and is not persisted in the tunnel profile. The OpenAI runtime API key is not forwarded into the MCP child process.

Managed Cloudflare runtime material is optional and disabled by default in v0.7.1. Only set:

```powershell
$env:CLOUDFLARED_MANAGED = "true"
```

when the selected tunnel is known to have managed Cloudflare runtime material provisioned. A `404 Managed Cloudflare tunnel runtime material not found` response means the tunnel should stay on the normal direct control-plane path with managed Cloudflare disabled.

See [OpenAI Secure MCP Tunnel](OPENAI_SECURE_TUNNEL.md) for the complete trust boundary, installation hash, permissions, readiness checks, and troubleshooting flow.

## Windows security notes

Windows normally restricts creation of symbolic links unless Developer Mode or elevated privileges are enabled. The project's security regression tests use directory junctions on Windows so path-escape protections can be validated without requiring Administrator privileges.

The raw-shell adapter uses PowerShell on Windows and Bash on POSIX systems. Host-level raw shell and host filesystem capabilities remain disabled by default and still require local policy gates plus an active owner-issued permission lease.

## Process execution

Prefer native executables (`git.exe`, `node.exe`, `python.exe`, `cmake.exe`, `ninja.exe`) in Windows process allowlists. Windows `.cmd`/`.bat` wrapper execution is intentionally not treated as equivalent to native executable execution because routing arbitrary arguments through `cmd.exe` changes the shell-injection threat model.

Managed processes support bounded pipe-backed stdin through `process_write` and `process_close_stdin`. This is useful for REPL-like tools and persistent engineering helpers, but it is not a PTY/ConPTY terminal emulator. A true terminal adapter remains a separate future layer.

## Semantic code intelligence

v0.7.1 supports owner-configured language servers for definition, references, hover, document symbols, and diagnostics. Language servers remain executable-allowlisted and workspace-bounded. Configure them under the `lsp` section of `config/policy.yaml`; see [LSP](LSP.md).
