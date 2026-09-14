# Windows runtime

Remote Workstation MCP v0.7.0 validates the core runtime on both Ubuntu and Windows and adds an optional outbound OpenAI Secure MCP Tunnel path for ChatGPT/cloud access.

## Requirements

- Windows 10/11
- Node.js 22+
- npm
- Git
- OpenSSH client when SSH tools are needed
- PowerShell 5.1+ or PowerShell 7+

## Setup

From PowerShell:

```powershell
cd "$HOME\Documents"
git clone https://github.com/Tunglam0605/remote-workstation-mcp.git
cd remote-workstation-mcp
git checkout v0.7.0
npm run setup:windows
```

The setup script creates a safe default workspace at:

```text
%USERPROFILE%\Documents\RemoteWorkspaces
```

It creates local `config/policy.yaml` and `config/hosts.yaml` only when they do not already exist, then runs typecheck, tests, build, and plugin validation.

## Local-only start

```powershell
npm run start:windows
```

The server remains loopback-only:

```text
MCP:    http://127.0.0.1:8765/mcp
Health: http://127.0.0.1:8765/healthz
```

Verify from a second PowerShell window:

```powershell
Invoke-RestMethod http://127.0.0.1:8765/healthz
```

Expected fields include:

```text
ok      : True
version : 0.7.0
mode    : workspace
```

## ChatGPT/cloud start through OpenAI Secure MCP Tunnel

Do **not** expose port 8765 to the Internet. Install the verified official OpenAI tunnel-client package:

```powershell
npm run openai:tunnel:install:windows
```

Then set the OpenAI tunnel id and runtime API key in the current PowerShell session:

```powershell
$env:CONTROL_PLANE_TUNNEL_ID = "tunnel_0123456789abcdef0123456789abcdef"
$env:CONTROL_PLANE_API_KEY = "<runtime-api-key>"
npm run start:openai:windows
```

The supervisor keeps MCP bound to loopback, enables bearer authentication, gives the tunnel principal read/write/execute scopes by default, runs `tunnel-client doctor`, starts the tunnel, and waits for `/readyz` before reporting success. The local MCP bearer is generated per run and is not persisted in the tunnel profile. The OpenAI runtime API key is not forwarded into the MCP child process.

See [OpenAI Secure MCP Tunnel](OPENAI_SECURE_TUNNEL.md) for the complete trust boundary, installation hash, permissions, and troubleshooting flow.

## Windows security notes

Windows normally restricts creation of symbolic links unless Developer Mode or elevated privileges are enabled. The project's security regression tests use directory junctions on Windows so the path-escape protections can be validated without requiring Administrator privileges.

The raw-shell adapter uses PowerShell on Windows and Bash on POSIX systems. Host-level raw shell and host filesystem capabilities remain disabled by default and still require local policy gates plus an active owner-issued permission lease.

## Process execution

Prefer native executables (`git.exe`, `node.exe`, `python.exe`, `cmake.exe`, `ninja.exe`) in Windows process allowlists. Windows `.cmd`/`.bat` wrapper execution is intentionally not treated as equivalent to native executable execution because routing arbitrary arguments through `cmd.exe` changes the shell-injection threat model.

Managed processes now support bounded pipe-backed stdin through `process_write` and `process_close_stdin`. This is useful for REPL-like tools and persistent engineering helpers, but it is not a PTY/ConPTY terminal emulator. A true terminal adapter remains a separate future layer.

## Semantic code intelligence

v0.7.0 also supports owner-configured language servers for definition, references, hover, document symbols, and diagnostics. Language servers remain executable-allowlisted and workspace-bounded. Configure them under the `lsp` section of `config/policy.yaml`; see [LSP](LSP.md).
