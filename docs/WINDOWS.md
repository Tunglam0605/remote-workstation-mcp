# Windows runtime

Remote Workstation MCP v0.6.1 validates the core runtime on both Ubuntu and Windows.

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
git checkout v0.6.1
npm run setup:windows
```

The setup script creates a safe default workspace at:

```text
%USERPROFILE%\Documents\RemoteWorkspaces
```

It creates local `config/policy.yaml` and `config/hosts.yaml` only when they do not already exist, then runs typecheck, tests, build, and plugin validation.

## Start

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
version : 0.6.1
mode    : workspace
```

## Windows security notes

Windows normally restricts creation of symbolic links unless Developer Mode or elevated privileges are enabled. The project's security regression tests use directory junctions on Windows so the path-escape protections can be validated without requiring Administrator privileges.

The raw-shell adapter uses PowerShell on Windows and Bash on POSIX systems. Host-level raw shell and host filesystem capabilities remain disabled by default and still require local policy gates plus an active owner-issued permission lease.

## Process execution

Prefer native executables (`git.exe`, `node.exe`, `python.exe`, `cmake.exe`, `ninja.exe`) in Windows process allowlists. Windows `.cmd`/`.bat` wrapper execution is intentionally not treated as equivalent to native executable execution because routing arbitrary arguments through `cmd.exe` changes the shell-injection threat model. Typed/safe support for common wrappers such as npm/npx is tracked separately.

## ChatGPT connection boundary

The Windows runtime binds only to `127.0.0.1`. ChatGPT running in the cloud cannot directly reach this loopback endpoint. Use a supported secure MCP tunnel/connector model rather than opening port 8765 to the Internet.
