# Operations guide

This guide covers the managed Linux/Ubuntu installation path for Remote Workstation MCP v0.5.x.

## 1. Install

```bash
git clone https://github.com/Tunglam0605/remote-workstation-mcp.git
cd remote-workstation-mcp
npm run install:user
```

The installer runs typecheck/tests/build, packs the same installable artifact used by releases, installs a versioned runtime, creates safe local configuration, and starts a `systemd --user` service.

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

## 2. Run the doctor

After installation, run:

```bash
npm run doctor
```

or from the managed installation:

```bash
node ~/.local/share/remote-workstation-mcp/current/scripts/doctor-user.mjs
```

Machine-readable output:

```bash
node ~/.local/share/remote-workstation-mcp/current/scripts/doctor-user.mjs --json
```

Strict mode returns non-zero for warnings as well as errors:

```bash
node ~/.local/share/remote-workstation-mcp/current/scripts/doctor-user.mjs --strict
```

The doctor checks Node/runtime prerequisites, config presence and permissions, YAML parsing, workspace roots, managed version link, systemd service/timer state, and loopback `/healthz`.

## 3. Validate service health

```bash
systemctl --user status remote-workstation-mcp.service
curl -fsS http://127.0.0.1:8683/healthz
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

## 4. Configure workspaces

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
fullControl:
  allowRawShell: false
  allowHostFilesystem: false
privileged:
  allowSudo: false
  maxRuntimeMs: 600000
```

After policy changes:

```bash
systemctl --user restart remote-workstation-mcp.service
```

## 5. Configure SSH hosts

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

## 6. Build/test task profiles

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

## 7. Temporary full user-level control

Keep these gates false during normal operation:

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

## 8. Updates

### Windows managed install

v0.7.9 defaults to stable automatic checks through the stable launcher. Start-at-logon invokes `Boot`; a GitHub Release check runs only when the previous check is at least 12 hours old. Update/network failure is non-fatal and the installed runtime still starts.

```powershell
$ctl = "$env:LOCALAPPDATA\RemoteWorkstationMCP\bin\rwmcp.ps1"
& $ctl -Action UpdateCheck
& $ctl -Action Update
& $ctl -Action AutoUpdateOn
& $ctl -Action AutoUpdateOff
```

Windows update state is stored at `%LOCALAPPDATA%\RemoteWorkstationMCP\update.json`. Candidate versions are installed in new slots. Startup health/tunnel readiness failure triggers automatic rollback and failed-release backoff.

### Linux managed install

Default scheduled mode remains `notify`.

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

The Linux updater downloads official GitHub Release assets, verifies SHA-256, installs into a new version slot, restarts the service, checks health and rolls back on failure. It is upgrade-only: it will not silently downgrade to an older release.

Managed Linux installs use `auto_patch`: verified patch releases install automatically, while minor/major releases are detected but require explicit owner approval. Advanced modes remain available for compatibility: `off`, `notify`, `auto_patch`, or `auto`; `auto` is not the managed default.

## 9. Rollback

Rollback is the explicit downgrade mechanism:

```bash
bash ~/.local/share/remote-workstation-mcp/current/scripts/rollback-user.sh
```

Then verify:

```bash
curl -fsS http://127.0.0.1:8683/healthz
systemctl --user status remote-workstation-mcp.service
```

## 10. Uninstall

Safe default: disable/remove the user services but preserve local versions, config and audit data:

```bash
npm run uninstall:user
```

or:

```bash
bash ~/.local/share/remote-workstation-mcp/current/scripts/uninstall-user.sh
```

Destructive purge requires two explicit flags:

```bash
bash scripts/uninstall-user.sh --purge --yes
```

That permanently removes both the managed data directory and local configuration directory.

## 11. Common troubleshooting

### Policy file error

Run the doctor, then inspect logs:

```bash
npm run doctor
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
- Windows OpenSSH targets set `remoteShell: windows-powershell`; POSIX/Linux targets keep the default `posix`.

### Full-control tool denied

Check:

1. local policy gate is true;
2. lease is active;
3. lease mode is `full_control`;
4. lease client ID matches the service/client profile;
5. service was restarted after policy changes.

### Service starts but client cannot connect

Confirm the client is using the correct transport. A cloud client cannot connect directly to workstation loopback. Use a supported secure outbound tunnel/connector.

## 12. Operational recommendations

- Keep the service account unprivileged.
- Keep full-control leases short.
- Never store passwords in MCP config.
- Use dedicated client profile IDs.
- Review `audit.jsonl` after elevated sessions.
- Keep production credentials outside authorized workspaces when possible.
- Use VM/container isolation for untrusted repositories or build scripts.
- Do not expose port 8683 directly to the Internet.
- Run the doctor after installation, updates, or configuration changes.
