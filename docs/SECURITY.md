# Security

Remote Workstation MCP can read/write files and execute development tools. In v0.5 it can also reach owner-approved SSH hosts and, only with an explicit owner lease, expose user-level host filesystem and raw shell capabilities. Treat it as privileged local automation software.

## Security model

1. **Safe by default** — the normal mode is workspace-scoped and process execution is restricted to owner-configured executables.
2. **Owner-controlled policy** — `policy.yaml`, `hosts.yaml`, update settings and permission leases are local control-plane state; MCP tools do not rewrite them.
3. **Canonical path checks** — workspace paths are resolved through real paths so traversal and symlink escape attempts fail.
4. **No implicit shell** — normal process execution uses executable + argv with `shell: false`.
5. **Environment minimization** — child processes inherit only allowlisted variables and secret-like variable names are filtered.
6. **Bounded execution** — process output and runtime are capped by policy; long-running processes are tracked by the agent.
7. **SSH allowlists** — remote access is limited to named hosts and per-host executable allowlists, with BatchMode authentication, host-key checking and forwarding disabled.
8. **Multi-agent concurrency** — file reads return SHA-256 values; writes can require an expected hash so stale agents fail instead of silently overwriting newer changes.
9. **Explicit elevation** — full-control capabilities require a short-lived local owner lease plus explicit policy gates. The AI cannot grant or extend the lease through MCP.
10. **Client binding** — full-control leases can be bound to the dedicated client profile ID used by the MCP process.
11. **Loopback HTTP** — the built-in HTTP service binds to `127.0.0.1`; remote AI access should use a dedicated outbound tunnel/transport rather than exposing the port publicly.
12. **Managed service hardening** — the Linux user service runs with restrictive file permissions and `NoNewPrivileges=true`.

## Full-control boundary

`host_fs_*` and `shell_exec` are intentionally disabled until both conditions are true:

- local policy enables the corresponding `fullControl` gate; and
- the owner creates an active `full_control` lease locally.

A raw shell command runs with the operating-system permissions of the account running Remote Workstation MCP. This is powerful enough to alter that user's files, repositories, services and credentials that the OS account can access. Use short leases and supervise full-control sessions.

Root/Administrator control is **not** exposed by v0.5. A future implementation must use a separately isolated privileged helper with a narrow protocol instead of making the normal MCP service privileged.

## Important limitation: not an OS sandbox

The workspace path guard protects the built-in filesystem tools. It does not sandbox a child process. If the owner allows an interpreter, compiler, build script, debugger or shell, that process inherits the OS rights of the service account. Treat project code and build scripts as executable content.

For high-risk or untrusted repositories, use an additional VM/container/OS sandbox and keep the MCP policy least-privileged.

## SSH credential handling

- Prefer `ssh-agent`.
- Identity-file paths remain local configuration and are not returned through MCP.
- Password authentication is intentionally unsupported.
- Do not place SSH private keys, passwords or tokens in repository configuration.

## Update security

The managed updater reads GitHub Releases, downloads the versioned package and `SHA256SUMS.txt`, verifies SHA-256, installs into a new version slot, restarts the service, checks `/healthz`, and rolls back to the previous slot when the health check fails.

The default scheduled update mode is `notify`. Automatic modes are opt-in.

Checksums protect against accidental/corrupt downloads but are not a complete software-supply-chain trust system. Artifact signing/SBOM/provenance remain future hardening work.

## Never commit

- API keys or access tokens
- SSH private keys or passwords
- `.env`
- `config/policy.yaml` or `config/hosts.yaml`
- permission lease files
- production credentials
- private infrastructure inventories when sensitive

## Vulnerability reporting

For issues that could enable policy bypass, secret disclosure, unauthorized command execution, SSH policy escape, update compromise or permission-elevation bypass, use a GitHub Security Advisory rather than a public issue.
