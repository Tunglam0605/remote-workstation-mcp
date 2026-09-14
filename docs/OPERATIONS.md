# Operations guide

This guide covers the managed Linux/Ubuntu installation path for Remote Workstation MCP v0.5.

## 1. Install

```bash
git clone https://github.com/Tunglam0605/remote-workstation-mcp.git
cd remote-workstation-mcp
npm run install:user
```

The installer validates/builds the project, installs a versioned runtime, creates safe local configuration, and starts a `systemd --user` service.

Important paths:

```text
~/.local/share/remote-workstation-mcp/
├── versions/<version>/
├── current -> versions/<version>/
├── previous -> versions/<previous>/
└── runtime/
    ├── audit.jsonl
    └── permission-lease.json   # only while explicitly granted

~/.config/remote-workstation-mcp/
├── policy.yaml
├── hosts.yaml
└── update.env
```

## 2. Validate service health

```bash
systemctl --user status remote-workstation-mcp.service
curl -fsS http://127.0.0.1:8765/healthz
```

Expected health response includes `ok: true` and the installed version.

View logs:

```bash
journalctl --user -u remote-workstation-mcp.service -n 200 --no-pager
journalctl --user -u remote-workstation-mcp.service -f
```

Audit events:

```bash
tail -f ~/.local/share/remote-workstation-mcp/runtime/audit.jsonl
```

## 3. Configure workspaces

Edit:

```text
~/.config/remote-workstation-mcp/policy.yaml
```

Keep each root as narrow as practical. Example:

```yaml
version: 1
mode: workspace

workspaces:
  - id: robotics
    name: Robotics projects
    root: /home/USER/Projects/robotics
    readOnly: false

filesystem:
  maxReadBytes: 1048576
  maxWriteBytes: 1048576

search:
  maxResults: 100
  maxFiles: 5000
  maxFileBytes: 1048576

process:
  allowExecutables: [git, node, npm, npx, python3, cmake, ninja, make]
  inheritEnv: [PATH, HOME, LANG, LC_ALL, TERM, TMPDIR, TMP, TEMP]
  maxOutputBytes: 262144
  maxRuntimeMs: 600000

tasks: {}
```

After policy changes:

```bash
systemctl --user restart remote-workstation-mcp.service
```

## 4. Configure SSH hosts

Edit:

```text
~/.config/remote-workstation-mcp/hosts.yaml
```

Prefer `ssh-agent` and pre-verify host keys manually before enabling automation.

Test from the workstation first:

```bash
ssh user@host
```

Then use MCP `ssh_probe` before `ssh_exec`.

## 5. Build/test task profiles

Add stable repeated operations to `tasks` instead of asking an AI to reconstruct long command lines every time.

```yaml
tasks:
  app-test:
    program: npm
    args: [test]
    cwd: .
  cmake-build:
    program: cmake
    args: [--build, build]
    cwd: .
```

The program must also be present in `process.allowExecutables`.

## 6. Temporary full user-level control

Keep these gates absent/false during normal operation:

```yaml
fullControl:
  allowRawShell: false
  allowHostFilesystem: false
```

For a supervised engineering session, enable only what is required, restart the service, then issue a short local lease.

Managed HTTP profile example:

```bash
node ~/.local/share/remote-workstation-mcp/current/scripts/grant-permission.mjs \
  --mode full_control \
  --ttl 30m \
  --client-id local-http \
  --reason "supervised engineering session"
```

Check:

```bash
node ~/.local/share/remote-workstation-mcp/current/scripts/grant-permission.mjs --status
```

Revoke immediately when finished:

```bash
node ~/.local/share/remote-workstation-mcp/current/scripts/grant-permission.mjs --revoke
```

The lease also expires automatically.

## 7. Updates

Default scheduled mode is `notify`.

```bash
cat ~/.config/remote-workstation-mcp/update.env
```

Manual check:

```bash
node ~/.local/share/remote-workstation-mcp/current/scripts/update-user.mjs --check
```

Manual update:

```bash
node ~/.local/share/remote-workstation-mcp/current/scripts/update-user.mjs
```

The updater downloads official GitHub Release assets, verifies SHA-256, installs into a new version slot, restarts the service, checks health and rolls back on failure.

Automatic modes are opt-in:

```text
off
notify
auto_patch
auto
```

For security-sensitive systems, prefer `notify` and review release notes before updating.

## 8. Rollback

```bash
bash ~/.local/share/remote-workstation-mcp/current/scripts/rollback-user.sh
```

Then verify:

```bash
curl -fsS http://127.0.0.1:8765/healthz
systemctl --user status remote-workstation-mcp.service
```

## 9. Common troubleshooting

### Policy file error

```bash
journalctl --user -u remote-workstation-mcp.service -n 100 --no-pager
```

Validate YAML indentation and ensure configured workspace directories exist.

### Program denied

The executable must be present in `process.allowExecutables`. Add only the exact executable needed, then restart the service.

### SSH denied

Check all of the following:

- host ID exists in `hosts.yaml`;
- requested program is in that host's `allowPrograms`;
- host key is known/accepted according to policy;
- `ssh-agent` or configured identity file works outside MCP;
- remote root/cwd is allowed.

### Full-control tool denied

Check:

1. local policy gate is true;
2. lease is active;
3. lease mode is `full_control`;
4. lease client ID matches the service/client profile;
5. service was restarted after policy changes.

### Service starts but client cannot connect

Confirm the client is using the correct transport. A cloud client cannot connect directly to workstation loopback. Use a supported secure outbound tunnel/connector.

## 10. Operational recommendations

- Keep the service account unprivileged.
- Keep full-control leases short.
- Never store passwords in MCP config.
- Use dedicated client profile IDs.
- Review `audit.jsonl` after elevated sessions.
- Keep production credentials outside authorized workspaces when possible.
- Use VM/container isolation for untrusted repositories or build scripts.
- Do not expose port 8765 directly to the Internet.
