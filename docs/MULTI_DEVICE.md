# Multi-device control

Remote Workstation MCP v0.8.4 retains the **Direct Multi-Node** topology introduced in v0.8.3 and adds offline-first local recovery for each independent node.

## Preferred topology: every workstation connects directly

Each PC/laptop runs its own RWMCP instance and its own OpenAI Secure MCP Tunnel:

```text
                         ChatGPT Web
                    /        |         \
                   /         |          \
          Secure Tunnel  Secure Tunnel  Secure Tunnel
               |             |              |
          Windows Laptop   Ubuntu PC      Vision PC
              RWMCP          RWMCP           RWMCP
```

There is no workstation-to-workstation SSH hop in the normal control path. The devices do not need to share a LAN, VPN, IP range, or physical location. If one workstation is offline, the other direct nodes remain independently reachable.

OpenAI Secure MCP Tunnel is outbound-only from each workstation, so RWMCP remains bound to loopback and no inbound port needs to be opened on the PC.

## One tunnel per workstation

Use a distinct logical tunnel for every independent workstation. Give each ChatGPT custom MCP app a clear name, for example:

```text
Remote Workstation - TungLam Laptop
Remote Workstation - Ubuntu Vision PC
Remote Workstation - Office PC 65
```

RWMCP persists a stable local `device-identity.json` and exposes it through:

- `workstation_identity`
- `chatgpt_web_status`
- `system_info`

The identity is independent of DHCP/IP changes. `workstation_identity` also returns a recommended ChatGPT app name.

When multiple Remote Workstation apps are selected for one ChatGPT message, the model should resolve the requested machine by stable device identity/name and call that app directly.

## Windows node

Use the normal managed Windows installer and Control Center. Each Windows node needs its own Tunnel ID. The Windows runtime already supervises MCP + tunnel-client and automatically reconnects after process or network interruption.

## Linux node

Install the normal per-user runtime first:

```bash
git clone https://github.com/Tunglam0605/remote-workstation-mcp.git
cd remote-workstation-mcp
bash scripts/install-user.sh
```

Then configure the machine as a direct ChatGPT node with its own tunnel:

```bash
export CONTROL_PLANE_API_KEY='YOUR_RESTRICTED_RUNTIME_KEY'
bash scripts/setup-direct-node-linux.sh \
  --tunnel-id tunnel_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx \
  --name 'Ubuntu Vision PC'
```

The script:

1. installs the pinned official OpenAI `tunnel-client` for Linux and verifies its SHA-256;
2. stores the runtime key in `~/.config/remote-workstation-mcp/openai.env` with mode `0600`;
3. disables the old local-only RWMCP user service;
4. installs and starts `remote-workstation-mcp-openai.service`;
5. lets the RWMCP OpenAI supervisor generate an ephemeral MCP bearer for each run;
6. restarts automatically through `systemd --user` after a crash or network recovery.

Check it with:

```bash
bash scripts/direct-node-status-linux.sh
```

## Security boundary

Direct Multi-Node removes the workstation-to-workstation trust hop:

```text
ChatGPT app for one workstation
  -> OpenAI Secure MCP Tunnel
  -> authenticated request principal
  -> that workstation's local policy / access mode / audit
  -> that workstation's typed tools
```

Each node has its own local policy, audit log, workspaces, Full Access gates and Administrator/sudo boundary. A compromise or outage on one node does not grant access to another node.

## Legacy Hub / SSH mode

`device_list`, `device_probe`, `device_exec`, SSH host configuration and v0.8.2 pairing remain available for bootstrap, migration and explicitly owner-approved legacy workflows. They are **not** the preferred v0.8.3 path for routine multi-device work.

Use SSH when you intentionally need a gateway. For normal ChatGPT control of several independent PCs, install RWMCP + a separate Secure MCP Tunnel on every machine instead.
