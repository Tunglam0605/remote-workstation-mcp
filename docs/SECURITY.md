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
13. **Loopback HTTP** — the built-in HTTP service still binds to `127.0.0.1`; bearer authentication is a transport-auth foundation, not permission to expose the raw port to the Internet.
14. **Managed service hardening** — the Linux user service runs with restrictive file permissions and `NoNewPrivileges=true`.

## HTTP principal and scope boundary

HTTP authentication is optional so existing local stdio/loopback clients remain compatible. Enable it with local environment configuration:

```text
RWMCP_HTTP_AUTH_MODE=bearer
RWMCP_HTTP_BEARER_TOKEN=<32+ random characters>
RWMCP_HTTP_PRINCIPAL_ID=chatgpt-web
RWMCP_HTTP_PRINCIPAL_TYPE=mcp-http
RWMCP_HTTP_SCOPES=workstation.read,workstation.write,workstation.execute
```

The current bearer provider represents one locally configured authenticated HTTP principal. It is intended as a safe foundation for a trusted gateway/tunnel and for developing principal-aware policy. It is **not** the final public ChatGPT OAuth flow. A public/registered web connection must use the authentication mechanism required by that integration and map the authenticated identity/scopes into the same request-principal model.

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

The managed updater reads GitHub Releases, downloads the versioned package and `SHA256SUMS.txt`, verifies SHA-256, installs into a new version slot, restarts the service, checks `/healthz`, and rolls back to the previous slot when the health check fails.

The default scheduled update mode is `notify`. Automatic modes are opt-in.

Checksums protect against accidental/corrupt downloads but are not a complete software-supply-chain trust system. Artifact signing/SBOM/provenance remain future hardening work.

## Never commit

- API keys or access tokens
- HTTP bearer tokens
- SSH private keys or passwords
- `.env`
- `config/policy.yaml` or `config/hosts.yaml`
- permission lease files
- production credentials
- private infrastructure inventories when sensitive

## Vulnerability reporting

For issues that could enable policy bypass, secret disclosure, unauthorized command execution, SSH policy escape, authentication/scope bypass, update compromise or permission-elevation bypass, use a GitHub Security Advisory rather than a public issue.
