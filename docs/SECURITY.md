# Security

Remote Workstation MCP can read/write files and execute development tools. It can also reach owner-approved SSH hosts and, only with an explicit owner lease, expose user-level host filesystem and raw shell capabilities. Treat it as privileged local automation software.

## Security model

1. **Safe by default** — the normal mode is workspace-scoped and process execution is restricted to owner-configured executables.
2. **Owner-controlled policy** — `policy.yaml`, `hosts.yaml`, update settings and permission leases are local control-plane state; MCP tools do not rewrite them.
3. **Canonical path checks** — workspace paths are resolved through real paths so traversal and symlink escape attempts fail.
4. **No implicit shell** — normal process execution uses executable + argv with `shell: false`.
5. **Environment minimization** — child processes inherit only allowlisted variables and secret-like variable names are filtered.
6. **Bounded execution** — process output and runtime are capped by policy; long-running processes are tracked by the agent.
7. **SSH allowlists** — remote access is limited to named hosts and per-host executable allowlists, with BatchMode authentication, host-key checking and forwarding disabled.
8. **Multi-agent concurrency** — file reads return SHA-256 values; writes can require an expected hash so stale agents fail instead of silently overwriting newer changes. Larger coding jobs should use isolated Git worktrees.
9. **Explicit elevation** — full-control capabilities require a short-lived local owner lease plus explicit policy gates. The AI cannot grant or extend the lease through MCP.
10. **Authenticated principal when configured** — HTTP bearer mode establishes a request-scoped principal with explicit `workstation.read`, `workstation.write`, `workstation.execute` and/or `workstation.full_control` scopes before the MCP handler runs.
11. **Client-bound lease enforcement** — when an authenticated principal is present, its principal ID is used for client-bound permission lease evaluation; local transports fall back to `RWMCP_CLIENT_ID`.
12. **Fail-closed authenticated tool classification** — an authenticated principal cannot invoke a newly added tool until that tool has an explicit scope classification.
13. **Loopback HTTP** — the built-in HTTP service binds to `127.0.0.1`; bearer authentication is a transport-auth foundation, not permission to expose the raw port to the Internet.
14. **Owner-local Setup & Control Center** — the persistent browser UI binds to a dedicated loopback-only port, uses an ephemeral in-memory CSRF token embedded only in the served page, rejects non-loopback clients and cross-origin API requests, and is never registered as an MCP tool or exposed through the tunnel.
15. **Narrow runtime control** — local web runtime actions are limited to start/stop/restart/status and current-user start-at-logon registration. They do not accept arbitrary executable/argument input.
16. **Managed process identity** — the Windows supervisor records the launched executable path and start time; a PID alone is insufficient authority for a later stop operation.
17. **Secret separation** — non-secret setup state is stored outside the repository; on Windows the optional OpenAI runtime key is protected with current-user DPAPI and stripped from the MCP child environment.
18. **Version/config separation** — managed Windows application slots are separate from policy, hosts, settings, audit data and DPAPI secrets so an application update does not silently replace owner state.
19. **Managed service hardening** — the Linux user service runs with restrictive file permissions and `NoNewPrivileges=true`.

## Setup & Control Center boundary

The browser surface is an owner-local bootstrap and runtime-operations UI, not a general remote-administration API.

Supported configuration mutations are intentionally narrow:

- save the loopback MCP and dedicated Control Center ports;
- save the initial workspace path for a new default policy;
- save OpenAI tunnel/organization identifiers and the managed-Cloudflare preference;
- install the pinned official OpenAI tunnel-client on Windows;
- optionally store/remove the OpenAI runtime API key using Windows DPAPI;
- change the authenticated tunnel scopes exposed to `openai-tunnel`;
- change only `fullControl.allowHostFilesystem` and `fullControl.allowRawShell` in the owner policy;
- issue/revoke short `full_control` leases bound to `openai-tunnel`.

Supported runtime operations are also narrow:

- start the local MCP runtime;
- start the OpenAI tunnel runtime;
- stop/restart the managed runtime process tree;
- inspect MCP health/version/auth and tunnel readiness;
- register/remove a current-user start-at-logon task.

The browser UI can expose the raw-shell/host-filesystem gates, `workstation.full_control` transport scope, and short owner leases, but none of these bypass the existing three-layer authorization checks. It still does **not** expose sudo/Administrator enablement, SSH credential creation, or arbitrary command execution as a Control Center API.

An existing owner policy/hosts configuration is preserved rather than silently rewritten. Managed Windows installs keep these files outside application version slots.

The Control Center process generates an ephemeral token in memory and embeds it in the locally served HTML/JavaScript. It is not persisted and is not placed in the URL. Browser JavaScript presents it in the `x-rwmcp-setup-token` header for API requests. API requests also require a loopback socket and an accepted same-origin browser context.

Do not bind the Setup & Control Center to a LAN interface, publish it through a reverse proxy, or attach its privileged API to Secure MCP Tunnel. The MCP port may redirect local browser navigation to the dedicated Control Center port, but the tunnel continues to target only `/mcp`.

## Windows runtime supervisor boundary

The current-user Windows supervisor runs the MCP/tunnel runtime without Administrator privilege.

Its state file contains operational metadata such as PID, executable path, start time, mode and port. Before treating a recorded PID as managed, the supervisor verifies the live process executable path and start time. This reduces stale-PID/reuse risk before process-tree termination.

The process tree is stopped with an OS process-tree operation only after that identity check. Runtime stdin/stdout/stderr are detached from the operator console and redirected to owner-local files.

Start-at-logon uses the current-user Windows `Run` registry key. Managed installations point it at the stable launcher rather than a specific version slot, so updates do not leave autostart pinned to an obsolete release. Starting the managed runtime also ensures the independent Control Center supervisor is running.

## HTTP principal and scope boundary

HTTP authentication is optional so existing local stdio/loopback clients remain compatible. Enable it with local environment configuration:

```text
RWMCP_HTTP_AUTH_MODE=bearer
RWMCP_HTTP_BEARER_TOKEN=<32+ random characters>
RWMCP_HTTP_PRINCIPAL_ID=chatgpt-web
RWMCP_HTTP_PRINCIPAL_TYPE=mcp-http
RWMCP_HTTP_SCOPES=workstation.read,workstation.write,workstation.execute
```

The current bearer provider represents one locally configured authenticated HTTP principal. It is intended as a safe foundation for a trusted gateway/tunnel and principal-aware policy. Public/registered web connections must use the authentication mechanism required by that integration and map the authenticated identity/scopes into the same request-principal model.

Scope meanings are deliberately coarse and compositional:

- `workstation.read` — inspect workspaces, files, Git state/history, process output, diagnostics and approved host metadata/probes.
- `workstation.write` — workspace file mutation and typed Git mutation.
- `workstation.execute` — owner-approved tasks/processes and approved SSH execution.
- `workstation.full_control` — may enter full-control tools, but **does not grant full control by itself**.

`workstation.full_control` is only the transport authorization layer. `host_fs_*` and `shell_exec` still require an active matching `full_control` owner lease and their explicit local policy gates. Transport scopes cannot create, extend or bypass leases.

The bearer token is compared in constant time, is never returned by MCP tools, and must not be logged or committed. Use a high-entropy secret and rotate it if exposed.

## Full-control boundary

`host_fs_*` and `shell_exec` are intentionally disabled until all applicable conditions are true:

- the transport principal, when HTTP authentication is enabled, has `workstation.full_control`;
- local policy enables the corresponding `fullControl` gate; and
- the owner creates an active `full_control` lease locally, matching the principal/client ID when the lease is client-bound.

A raw shell command runs with the operating-system permissions of the account running Remote Workstation MCP. This is powerful enough to alter that user's files, repositories, services and credentials that the OS account can access. Use short leases and supervise full-control sessions.

Root/Administrator control is **not** exposed by the normal MCP process. A future implementation must use a separately isolated privileged helper with a narrow protocol instead of making the normal MCP service privileged.

## Important limitation: not an OS sandbox

The workspace path guard protects the built-in filesystem tools. It does not sandbox a child process. If the owner allows an interpreter, compiler, build script, debugger or shell, that process inherits the OS rights of the service account. Treat project code and build scripts as executable content.

For high-risk or untrusted repositories, use an additional VM/container/OS sandbox and keep the MCP policy least-privileged.

## SSH credential handling

- Prefer `ssh-agent`.
- Identity-file paths remain local configuration and are not returned through MCP.
- Password authentication is intentionally unsupported.
- Do not place SSH private keys, passwords or tokens in repository configuration.

## Update security

### Windows managed release

The v0.7.3 Windows installer resolves a GitHub Release, downloads the package and `SHA256SUMS.txt`, verifies SHA-256 before extraction, validates the package version, installs production dependencies in a new per-user version slot, validates the runtime version, and installs the pinned checksum-verified OpenAI tunnel-client.

Only then is the stable `current.txt` pointer moved to that slot. The prior valid slot is retained in `previous.txt` for owner-triggered rollback.

The Windows installer does **not** claim independent publisher authenticity from SHA-256 alone, and it does not silently grant admin privilege or alter full-control policy.

### Linux managed release

The Linux managed updater retains its version-slot, release checksum, health-check and rollback behavior documented in the operations guide.

### Supply-chain limitation

Published checksums protect against accidental/corrupt downloads and mismatches against the release metadata. They are not a complete independent software-supply-chain trust system if the GitHub release channel itself is compromised. Artifact signing, provenance and SBOM remain roadmap hardening work.

## Never commit

- API keys or access tokens
- HTTP bearer tokens
- SSH private keys or passwords
- `.env`
- owner `policy.yaml` or `hosts.yaml`
- permission lease files
- production credentials
- private infrastructure inventories when sensitive

## Vulnerability reporting

For issues that could enable policy bypass, secret disclosure, unauthorized command execution, SSH policy escape, authentication/scope bypass, update compromise, setup/control-token bypass, managed-process identity bypass or permission-elevation bypass, use a GitHub Security Advisory rather than a public issue.
