# Terminal Control Center (TUI)

Remote Workstation MCP v0.8.13 includes a dependency-free terminal user interface for owner-local administration. It complements the browser Control Center; it does not replace the MCP or Secure MCP Tunnel.

## Launch

Managed Linux installs create:

```bash
rwmcp-tui
```

The same interface can also be started from the package/runtime directory:

```bash
node dist/tui-cli.js
# or
remote-workstation-mcp --tui
```

For a non-interactive, secret-safe status snapshot:

```bash
rwmcp-tui --status
rwmcp-tui --status --json
```

The interactive TUI requires a terminal (TTY). The status snapshot does not.

## Controls

```text
↑ / ↓     move selection
Enter     edit or run selected action
r         refresh status
q / Esc   exit
```

The overview shows:

- workstation/device name;
- platform;
- managed runtime service state;
- OpenAI Secure MCP Tunnel readiness when available;
- loopback MCP port;
- current owner access mode;
- primary workspace.

## Editable settings

### Access mode

The TUI uses the same owner permission mapping as the Web Control Center:

- **Read only** -> `workstation.read` only;
- **Workspace** -> read/write/execute/admin-request inside owner-approved workspaces;
- **Full access** -> adds `workstation.full_control`, raw shell and host-filesystem gates.

Changing the mode updates the owner policy and tunnel scopes, then restarts the managed runtime. It does **not** silently enable `sudo`/root.

### MCP port

The managed default is:

```text
127.0.0.1:8683
```

Changing the port updates managed settings and the Linux Direct Node environment, then restarts the runtime.

### Device name

Changes the operator-visible workstation name while preserving the stable device ID.

### Tunnel ID

Valid values use the OpenAI tunnel format:

```text
tunnel_<32 lowercase hexadecimal characters>
```

The TUI never creates a new tunnel automatically. It only changes the local workstation binding to an owner-supplied Tunnel ID.

### Runtime API key

The key prompt is hidden: typed/pasted characters are not echoed.

- Linux: stored only in `~/.config/remote-workstation-mcp/openai.env` with owner-only file permissions.
- Windows: stored through the existing DPAPI secret helper; the plaintext key is not written to `settings.json`.

The TUI never displays the saved key after it is entered.

## Linux managed files

```text
~/.config/remote-workstation-mcp/policy.yaml
~/.config/remote-workstation-mcp/hosts.yaml
~/.config/remote-workstation-mcp/openai.env
~/.config/remote-workstation-mcp/settings.json
~/.local/share/remote-workstation-mcp/current/
```

Direct Node service:

```text
remote-workstation-mcp-openai.service
```

The service remains a `systemd --user` unit and the MCP listener remains loopback-only.

## Security boundary

The TUI is an **owner-local** interface. It does not expose configuration mutation as MCP tools. A remote AI cannot use the TUI to grant itself additional permissions. Access-mode changes still require a person or another process already operating inside the local user account to run the TUI.