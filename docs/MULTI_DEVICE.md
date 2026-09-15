# Multi-device Hub gateway

Remote Workstation MCP v0.8 introduces the accelerated multi-device foundation.

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

The remote machines do not need inbound Internet ports. In this first MVP they only need to be reachable from the Hub over the trusted office LAN or VPN.

## New MCP tools

- `device_list` — list the local Hub and owner-registered remote devices.
- `device_probe` — test reachability of one device.
- `device_exec` — execute one owner-allowlisted program on a registered remote device.

The existing SSH security model remains authoritative. A device is not remotely executable merely because it appears in the registry: its SSH configuration still controls identity, host-key checking, remote root, allowed programs and maximum runtime.

## Security boundary

```text
ChatGPT principal/scopes
  -> Hub policy + audit
  -> device registry
  -> SSH host allowlist
  -> BatchMode key authentication + strict host key
  -> remote executable allowlist
  -> remote OS account
```

`device_exec` requires `workstation.execute`. It does not grant Administrator/root access. Passwords and private keys are never returned to the model.

## MVP vs final paired-agent design

This first v0.8 path deliberately reuses the hardened SSH adapter so it can be validated quickly on real office machines.

The next multi-device step adds outbound RWMCP agents and one-time pairing so each device can connect to the Hub independently. That removes the requirement that the Hub share the target device's LAN/VPN while keeping a single ChatGPT app and per-device revocation.
