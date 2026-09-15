# Multi-device Hub gateway

Remote Workstation MCP v0.8.0 introduced the accelerated multi-device foundation; v0.8.1 is the current reliability patch.

## Goal

A single ChatGPT Web app reaches one always-on Remote Workstation Hub and can operate owner-registered machines behind it:

```text
Phone / home PC running ChatGPT Web
              |
       OpenAI Secure MCP Tunnel
              |
       Remote Workstation Hub
              |
       owner-approved SSH
        +-----+------+-----+
        |            |     |
    Ubuntu PC    Vision PC  other lab PC
```

The remote machines do not need inbound Internet ports. In the v0.8 series MVP they only need to be reachable from the Hub over the trusted office LAN or VPN.

## MCP tools

- `device_list` — list the local Hub and owner-registered remote devices, optionally probing online state.
- `device_probe` — test reachability of one registered device.
- `device_exec` — execute one owner-allowlisted program on a registered remote device.

After upgrading an already-connected custom MCP app, start a fresh ChatGPT chat or reconnect the app once so ChatGPT refreshes the MCP tool schema.

## Register an SSH-backed device

The owner configures the device in the managed `hosts.yaml`. Use key-based SSH authentication; do not store login passwords in the repository or in prompts. A host entry defines its friendly ID, SSH identity, remote root, executable allowlist and runtime bound.

The Hub then follows this flow:

```text
device_list
  -> device_probe(device)
  -> device_exec(device, allowlisted program, args, cwd)
```

The remote working directory stays constrained by the host's configured remote root, and the model never receives the private-key contents.

## Security boundary

```text
ChatGPT principal/scopes
  -> Hub policy + audit
  -> device registry
  -> SSH host allowlist
  -> BatchMode key authentication + host-key verification
  -> remote executable allowlist
  -> remote OS account
```

`device_exec` requires `workstation.execute`. It does not grant Administrator/root access. Passwords and private keys are never returned to the model.

## Connection resilience

v0.8.0 added a Windows watchdog for the OpenAI tunnel/runtime child. It uses capped reconnect delays of 1, 2, 5, 10 and 30 seconds, recycles a live-but-unready tunnel after a bounded outage, and reports `ONLINE`, `RECONNECTING` or `OFFLINE` through the Control Center.

v0.8.1 additionally self-heals the stable Windows launcher from the active runtime slot after managed updates, preventing an older installer from leaving old launcher behavior behind.

Intentional Stop remains authoritative: stopping the managed runtime terminates the supervisor tree, so the watchdog does not resurrect a runtime that the owner explicitly stopped.

## MVP vs paired-agent design

The v0.8 series deliberately reuses the hardened SSH adapter so multi-device control can be used immediately on real office machines.

The next step is one-time device pairing plus outbound RWMCP agents. That will remove the requirement that the Hub and target workstation share the same LAN/VPN while keeping one ChatGPT app, per-device revocation, policy and audit.
