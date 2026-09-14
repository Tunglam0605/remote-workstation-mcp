# Security

This project can modify files and execute development tools. Treat it as privileged local automation software.

## Security model

1. **Safe by default**: only configured workspaces and executables are accessible.
2. **Owner-controlled policy**: policy files are local and are not writable through MCP tools.
3. **No raw shell in v0.1**: process execution is argv-based with `shell: false`.
4. **Canonical path checks**: real paths are checked after symlink resolution.
5. **Environment minimization**: child processes receive only allowlisted non-secret environment variables.
6. **Loopback HTTP**: the built-in HTTP server binds to `127.0.0.1` only.
7. **Minimal audit**: tool name, workspace, result and duration are logged; sensitive payloads are not.

## Never commit

- API keys or access tokens
- SSH private keys or passwords
- `.env`
- `config/policy.yaml` or `config/hosts.yaml`
- private IP inventories if they are sensitive
- production credentials

## Full-control roadmap

The long-term design supports temporary owner-granted elevation up to full administrative control. Elevation will be implemented as an explicit, time-limited local capability lease. The AI client must not be able to grant itself permissions, extend its own lease, disable auditing, or rewrite the owner policy.

## Reporting vulnerabilities

Please open a GitHub security advisory rather than a public issue for vulnerabilities that could enable policy bypass, secret disclosure or unauthorized command execution.
