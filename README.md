# Remote Workstation MCP

**Install once on each workstation. Connect each node directly to ChatGPT. No SSH hub required.**

Remote Workstation MCP (RWMCP) securely connects ChatGPT to Windows and Linux engineering workstations. Each machine can run as an independent Direct Node with its own outbound OpenAI Secure MCP Tunnel. The local owner decides what ChatGPT may read, modify, or execute, while the workstation MCP itself stays bound to loopback instead of being exposed directly to the Internet.

## Current release

**v0.8.3**

v0.8.3 makes **Direct Multi-Node** the preferred multi-device topology:

```text
                         ChatGPT Web
                    /        |         \
                   /         |          \
          Secure Tunnel  Secure Tunnel  Secure Tunnel
               |             |              |
          Windows Laptop   Ubuntu PC      Vision PC
              RWMCP          RWMCP           RWMCP
```

Every workstation has its own stable device identity, its own Tunnel ID, its own local policy/audit boundary, and its own ChatGPT custom MCP app. Routine multi-device control no longer depends on one laptop acting as an SSH gateway or on the machines sharing a LAN/VPN.

New in v0.8.3:

- stable local `device-identity.json` independent of DHCP/IP changes;
- `workstation_identity` for deterministic target resolution;
- identity included in `chatgpt_web_status` and `system_info`;
- preferred direct-node instructions when multiple Remote Workstation apps are selected;
- SHA-256-verified OpenAI tunnel-client installation for Linux amd64/arm64;
- managed Linux Direct Node service through `systemd --user` with automatic restart/reconnect;
- legacy Hub/SSH/pairing tools retained only for bootstrap and explicitly requested gateway workflows.

OpenAI documents that ChatGPT can invoke multiple first-party and third-party apps in a single prompt. For private/local MCP servers, Secure MCP Tunnel keeps the MCP server private while providing ChatGPT reachability. Each independent tunnel should use its own Tunnel ID.

See [Multi-device control](docs/MULTI_DEVICE.md).

Default managed Windows endpoints remain:

- MCP: `127.0.0.1:8683`
- Control Center: `127.0.0.1:8684`
- automatic updates: enabled
- update channel: `stable`

Linux Direct Nodes use the managed per-user RWMCP install plus `remote-workstation-mcp-openai.service`.

## New user path: from zero to READY

A first-time user only needs to complete this flow once:

```text
Download installer
      -> install RWMCP
      -> create OpenAI Secure MCP Tunnel
      -> create restricted Runtime API key
      -> enter Tunnel ID + Organization ID + API key in Control Center
      -> Prepare this PC for ChatGPT
      -> add the custom MCP app in ChatGPT Web
      -> verify chatgpt_web_status
      -> READY
```

After that, RWMCP starts with Windows and maintains the tunnel automatically.

## 1. Download the Windows installer

Open the latest GitHub Release and download `install-windows.cmd`.

The v0.8.3 release contains:

- `install-windows.cmd`
- `install-windows.ps1`
- `remote-workstation-mcp-v0.8.3.tgz`
- `SHA256SUMS.txt`


Double-click `install-windows.cmd`. The installer checks prerequisites, downloads the verified release package, installs the runtime and OpenAI tunnel client, creates the stable launcher, configures startup, initializes automatic stable updates, and opens the local Control Center.

Normal users do **not** need to clone this repository or run `npm install`.

## 2. Create an OpenAI Secure MCP Tunnel

RWMCP keeps the workstation MCP on `127.0.0.1`. ChatGPT reaches it through an outbound OpenAI Secure MCP Tunnel.

Open OpenAI Platform **Tunnels**:

`https://platform.openai.com/settings/organization/tunnels`

Create a tunnel for this workstation, for example `Remote Workstation - Engineering PC`, then copy the generated ID:

```text
tunnel_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

The account/role creating or managing the tunnel needs the relevant **Tunnels Read + Manage** permission. The runtime user that will operate the tunnel needs **Tunnels Read + Use**.

> Keep each production workstation on its own tunnel when practical. It gives cleaner revocation, auditing, and failure isolation.

## 3. Create the Runtime API key

Open OpenAI Platform **Runtime API keys**:

`https://platform.openai.com/settings/organization/api-keys`

Create a **Restricted** runtime key and grant only:

- **Tunnels: Read**
- **Tunnels: Use**

Copy the key once and keep it private.

Do **not** use an OpenAI Admin API key as the long-lived RWMCP runtime key. Admin keys are only needed for administrative tunnel CRUD workflows.

## 4. Configure the local Control Center

The Control Center opens locally at:

```text
http://127.0.0.1:8684
```

![Control Center v0.8.1](docs/images/v0.8.1/01-control-center-home-v081.png)

Open **Settings**.

![Quick setup](docs/images/v0.8.1/02-settings-quick-setup-v081.png)

Enter:

1. **Authorized workspace root** - the folder normal Workspace-mode tools may access.
2. **Tunnel ID** - the `tunnel_...` value created above.
3. **Organization ID** - when your tunnel/account is organization-scoped or the account can address multiple organizations.
4. **Runtime API key** - the restricted Tunnels Read + Use key.
5. Keep **Store runtime key with Windows DPAPI** enabled for normal managed Windows use.

![OpenAI connection settings](docs/images/v0.8.1/03-settings-connection-v081.png)

Then choose **Prepare this PC for ChatGPT**.

The wizard saves the non-secret configuration, protects the runtime key with Windows DPAPI, verifies `tunnel-client`, starts MCP + the Secure MCP Tunnel, waits for readiness, and enables start-at-logon.

![Runtime controls](docs/images/v0.8.1/04-settings-runtime-v081.png)

## 5. Add Remote Workstation to ChatGPT Web

OpenAI currently calls this a **custom MCP app**. Older UI or documentation may call it a connector or plugin.

Current OpenAI documentation places custom MCP app setup under **ChatGPT Settings / Workspace Settings -> Apps**. Developer Mode may need to be enabled first, depending on the workspace and plan.

Typical flow:

1. Open ChatGPT Web.
2. Open **Settings -> Apps**.
3. Enable **Developer Mode** if your workspace requires it.
4. Choose **Create** / **Add custom app**.
5. Name it **Remote Workstation**.
6. Choose the **Tunnel** connection type.
7. Select the authorized tunnel or paste the same `tunnel_...` ID configured in RWMCP.
8. Keep the workstation Control Center in READY state while ChatGPT performs MCP discovery.
9. Review the discovered RWMCP tools before publishing or enabling the app for other users.

Direct settings entry point currently used by OpenAI:

`https://chatgpt.com/#settings/Connectors`

Product UI and plan availability can change independently of RWMCP. As of September 2026, OpenAI documents full MCP write/modify support on ChatGPT Web for Business, Enterprise and Edu workspaces; Pro has more limited developer-mode MCP support. Check the current OpenAI Developer Mode documentation before a wider deployment.

Detailed guide: [ChatGPT Web custom app setup](docs/CHATGPT_WEB.md).

## 6. Verify the end-to-end connection

When the workstation is configured correctly, the Control Center shows MCP healthy, tunnel READY, bearer authentication enabled, and start-at-logon ON.

![READY state](docs/images/v0.8.1/07-ready-online-v081.png)

In ChatGPT, invoke the Remote Workstation app and ask:

> Use Remote Workstation. Call `chatgpt_web_status` first. Do not modify anything. Report whether the authenticated control path is verified, the effective scopes, policy mode and authorized workspace names.

A healthy result includes:

```text
ok: true
chatgptWeb.authenticated: true
chatgptWeb.secureTunnelPrincipal: true
chatgptWeb.directControlPathVerified: true
```

Then verify `workspace_list` before allowing writes or execution.

## Access modes

RWMCP exposes exactly three owner-selected access modes:

| Mode | Meaning |
| --- | --- |
| **Read only** | Inspect files, Git state, status, and diagnostics. No writes or program execution. |
| **Workspace** | Read, write, and execute approved workflows inside owner-authorized workspaces. Recommended default. |
| **Full access** | Host filesystem and raw shell using the permissions of the current Windows user. |

**Full Access is not Administrator.**

Administrator execution is a separate one-shot path:

```text
AI request
   -> local owner approval in Control Center
   -> Windows RunAs / UAC
   -> one approved privileged execution
```

![Full access confirmation](docs/images/v0.8.1/06-full-access-confirm-v081.png)

A mode change cannot silently grant Administrator rights.

## After first setup

After the first successful setup, you do **not** need to:

- run the installer again;
- clone the repository;
- run `git pull`;
- run `npm install` or `npm build`;
- launch PowerShell manually on each boot;
- recreate the tunnel after every restart;
- re-enter the runtime API key after each update.

RWMCP automatically:

- starts after the Windows user signs in;
- starts the MCP runtime;
- reconnects the OpenAI Secure MCP Tunnel;
- keeps owner configuration and DPAPI-protected secrets outside version slots;
- checks the stable release channel when due;
- downloads and SHA-256 verifies release packages;
- installs updates into a new version slot;
- verifies MCP health and tunnel readiness;
- automatically rolls back to the previous slot when candidate activation fails.

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

## Automatic stable updates

Advanced settings exposes **Automatic stable updates** and **Check for updates**.

![Advanced settings](docs/images/v0.8.1/05-settings-advanced-v081.png)

![Automatic stable updates](docs/images/v0.8.1/08-auto-update-v081.png)

Managed defaults:

```text
enabled            = true
channel            = stable
checkOnStartup     = true
checkIntervalHours = 12
```

Production updates come from GitHub Releases. RWMCP does not `git pull` a production source tree. It downloads the release package and checksum manifest, verifies SHA-256, installs a new slot, switches the active pointer, validates health/readiness, and rolls back automatically on failure.

## Managed Windows layout

```text
%LOCALAPPDATA%\RemoteWorkstationMCP\
  bin\
    rwmcp.ps1
    install-windows-release.ps1
    update-windows.ps1
  config\
  runtime\
  secrets\
  versions\
    v0.7.9\
    v0.8.1\
  current.txt
  previous.txt
  update.json
  settings.json
  audit.jsonl
```

The stable launcher resolves `current.txt`, so startup follows the active version automatically after an update or rollback.

## v0.7.10 Control Center port ownership hardening

The default Control Center port is `8684`. v0.7.10 verifies that the listener on that port belongs to the managed Control Center process tree before reporting it healthy.

If another process owns `8684`, RWMCP does not report a false READY state. It reports the conflicting PID so the owner can close the application or choose another Control Center port in Advanced settings.

## Documentation

- [Multi-device Hub](docs/MULTI_DEVICE.md)
- [Windows quick start](docs/QUICKSTART_WINDOWS.md)
- [ChatGPT Web custom app setup](docs/CHATGPT_WEB.md)
- [OpenAI Secure MCP Tunnel](docs/OPENAI_SECURE_TUNNEL.md)
- [Windows managed runtime](docs/WINDOWS.md)
- [Setup & Control Center](docs/SETUP_CONSOLE.md)
- [Operations](docs/OPERATIONS.md)
- [Security](docs/SECURITY.md)
- [Architecture](docs/ARCHITECTURE.md)

## Development setup

The Git workflow below is for contributors only; it is not required for a normal installed workstation.

```powershell
git clone https://github.com/Tunglam0605/remote-workstation-mcp.git
cd remote-workstation-mcp
npm install
npm run typecheck
npm test
npm run build
```

## License

Apache-2.0
