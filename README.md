# Remote Workstation MCP

**Install once. Start with Windows. Update automatically.**

Remote Workstation MCP (RWMCP) lets an authorized AI client such as ChatGPT securely inspect and operate a Windows engineering workstation under permissions selected by the local owner.

## Current release

**v0.7.10**

Default managed Windows endpoints:

- MCP: `127.0.0.1:8683`
- Control Center: `127.0.0.1:8684`
- update channel: `stable`
- automatic updates: enabled by default

## Quick install on Windows

### Step 1 - Download the installer

Open the latest GitHub Release and download `install-windows.cmd`.

The release also publishes `install-windows.ps1`, `remote-workstation-mcp-v0.7.10.tgz`, and `SHA256SUMS.txt`.

### Step 2 - Run the installer once

Double-click `install-windows.cmd`.

The installer automatically:

- checks prerequisites and can install Node.js LTS and Git through `winget` when missing;
- downloads the stable release package from GitHub Releases;
- verifies SHA-256 before installation;
- installs the runtime into a versioned per-user slot;
- installs/verifies the OpenAI `tunnel-client`;
- creates the stable launcher;
- configures current-user startup;
- enables stable automatic updates;
- opens the local Control Center.

No repository clone is required for normal use.

### Step 3 - First-time setup

The Control Center opens locally at `http://127.0.0.1:8684`.

![Control Center](docs/images/v0.7.10/01-control-center-home.png)

Open **Settings**. Enter the authorized workspace root and owner-specific OpenAI connection values, then choose **Prepare this PC for ChatGPT**.

![Quick setup](docs/images/v0.7.10/02-settings-quick-setup.png)

The saved runtime API key is protected with Windows DPAPI and is never read back into the browser.

### Step 4 - Configure the connection

Settings contains the current production sections for workstation configuration, OpenAI connection, runtime control, and advanced configuration.

![Connection settings](docs/images/v0.7.10/03-settings-connection.png)

The daily dashboard intentionally stays small: **Connection**, **Access mode**, and **Settings**.

### Step 5 - Verify READY

A healthy workstation shows MCP healthy, OpenAI tunnel ready, bearer authentication enabled, start-at-logon enabled, and the green ChatGPT-ready state.

![Ready state](docs/images/v0.7.10/07-ready-state.png)

## After first setup

After the first successful setup, you do **not** need to:

- run the installer again;
- run `git pull`;
- run `npm install` or `npm build`;
- launch PowerShell manually on every boot;
- set up the OpenAI tunnel again after every restart.

RWMCP will:

- start automatically when the Windows user signs in;
- start the MCP runtime;
- reconnect the OpenAI Secure MCP Tunnel;
- preserve owner configuration and DPAPI-protected secrets outside version slots;
- check the stable release channel when due;
- install verified updates into a new version slot;
- verify MCP health and tunnel readiness;
- automatically roll back if the new runtime does not become healthy.

Windows startup uses:

```text
HKCU\Software\Microsoft\Windows\CurrentVersion\Run
        |
        v
%LOCALAPPDATA%\RemoteWorkstationMCP\bin\rwmcp.ps1 -Action Boot
        |
        +--> check stable update when due
        +--> start runtime
        +--> start OpenAI tunnel
        +--> verify health/readiness
```

## Access modes

RWMCP exposes exactly three owner-selected access modes:

| Mode | Meaning |
| --- | --- |
| **Read only** | Inspect files, Git state, status, and diagnostics. No file writes or program execution. |
| **Workspace** | Read, write, and execute approved workflows inside owner-authorized workspaces. Recommended default. |
| **Full access** | Host filesystem and raw shell using the permissions of the current Windows user. |

**Full Access is not Administrator.**

Administrator execution is a separate one-shot flow:

```text
AI request
   -> local owner approval in Control Center
   -> Windows RunAs / UAC
   -> one approved privileged execution
```

A mode switch can never silently grant Administrator rights.

![Full access confirmation](docs/images/v0.7.10/06-full-access-confirm.png)

## Control Center

Production v0.7.10 uses a dedicated loopback Control Center on port `8684`.

The Settings modal currently contains these sections:

- **Quick setup for ChatGPT**
- **Workstation**
- **OpenAI connection**
- **Runtime status**
- **Configuration**
- **Advanced settings**

Advanced settings includes **Automatic stable updates** and **Check for updates**.

![Advanced settings](docs/images/v0.7.10/05-settings-advanced.png)

![Automatic stable updates](docs/images/v0.7.10/08-auto-update.png)

## Automatic updates and rollback

Managed Windows installs use these defaults:

- `enabled = true`
- `channel = stable`
- `checkOnStartup = true`
- `checkIntervalHours = 12`
- distribution source: official GitHub Releases

Production does **not** update by running `git pull` in a source tree. The update flow downloads the release package and `SHA256SUMS.txt`, verifies SHA-256, installs a new version slot, switches the stable pointer, starts the candidate, verifies MCP health + tunnel readiness, and rolls back on failure.

Typical layout:

```text
%LOCALAPPDATA%\RemoteWorkstationMCP\
  bin\
    rwmcp.ps1
    install-windows-release.ps1
    update-windows.ps1
  config\
  runtime\
  audit\
  secrets\
  versions\
    v0.7.9\
    v0.7.10\
  current.txt
  previous.txt
  update.json
  settings.json
```

Owner policy, settings, audit data, SSH host configuration, update state, and DPAPI secrets are stored outside application version slots.

## v0.7.10 Control Center port ownership hardening

The default Control Center port is `8684`.

v0.7.10 verifies that the listener on `8684` belongs to the managed Control Center process tree before reporting it healthy. If another process owns the port, RWMCP does not claim a false READY state and reports the conflicting process/PID so the owner can close that application or select another Control Center port in Advanced settings.

## Stable launcher commands

```powershell
$ctl = "$env:LOCALAPPDATA\RemoteWorkstationMCP\bin\rwmcp.ps1"

& $ctl -Action Setup
& $ctl -Action Start
& $ctl -Action StartOpenAI
& $ctl -Action Boot
& $ctl -Action Stop
& $ctl -Action Restart
& $ctl -Action Status
& $ctl -Action AutostartOn
& $ctl -Action AutostartOff
& $ctl -Action UpdateCheck
& $ctl -Action AutoUpdateOn
& $ctl -Action AutoUpdateOff
& $ctl -Action Update
& $ctl -Action Rollback
```

These are owner-local maintenance commands. Normal users should not need them after first setup.

## Documentation

- [Windows quick start](docs/QUICKSTART_WINDOWS.md)
- [Windows managed runtime](docs/WINDOWS.md)
- [Setup & Control Center](docs/SETUP_CONSOLE.md)
- [ChatGPT Web connection](docs/CHATGPT_WEB.md)
- [OpenAI Secure MCP Tunnel](docs/OPENAI_SECURE_TUNNEL.md)
- [Operations](docs/OPERATIONS.md)
- [Security](docs/SECURITY.md)
- [Architecture](docs/ARCHITECTURE.md)

## Development setup

Contributors can still work from a Git checkout:

```powershell
git clone https://github.com/Tunglam0605/remote-workstation-mcp.git
cd remote-workstation-mcp
npm install
npm run typecheck
npm test
npm run build
```

This development workflow is separate from the managed production installer.

## License

Apache-2.0
