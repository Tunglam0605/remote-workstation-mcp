# Linux privileged host reboot reference review

This record documents the authoritative sources used for the Ubuntu owner-approved host reboot flow introduced after v0.24.0.

## systemd / systemctl

Sources:
- https://www.freedesktop.org/software/systemd/man/latest/systemctl.html
- https://cgit.freedesktop.org/systemd/systemd/tree/man/systemctl.xml
- https://cgit.freedesktop.org/systemd/systemd/tree/src/systemctl/systemctl.c

Relevant evidence:
- `systemctl reboot` requests a system reboot.
- `--no-block` verifies and enqueues the requested operation without synchronously waiting for completion.
- `--force` on reboot changes shutdown semantics and may skip normal service shutdown; repeated force can risk data loss.

RWMCP decisions:
- The typed Linux host action is fixed to `/usr/bin/systemctl --no-block reboot`.
- RWMCP intentionally does not use `--force` or `--ignore-inhibitors`.
- `--no-block` lets the local approval flow persist a success/failure result after systemd accepts the job and before the node disappears from the network.
- Runtime restart remains a different action and must never be presented as equivalent to host reboot.

## sudo

Sources:
- https://www.sudo.ws/docs/man/
- https://man7.org/linux/man-pages/man8/sudo.8.html
- https://man7.org/linux/man-pages/man5/sudoers.5.html

Relevant evidence:
- When `sudo -k` is used with a command, cached credentials are ignored and sudo requests authentication again if the local policy requires it.
- sudo policy controls whether a permitted user may execute the requested command; RWMCP must not bypass that policy.

RWMCP decisions:
- The owner-local TUI invokes `sudo -k -- /usr/bin/systemctl --no-block reboot`.
- RWMCP does not collect, proxy, store or log the sudo password; sudo interacts directly with the owner's terminal.
- A generic Linux root-shell approval path is not introduced.
- Only the exact typed reboot request can be approved from the Ubuntu TUI; other Linux admin requests can be denied but not elevated.
- Work Session workflow interlocks are checked immediately before approval so a reboot fails closed while owned engineering work is active.

## Runtime confinement note

The managed MCP service is intentionally constrained and may run with Linux `NoNewPrivileges`-style restrictions. Therefore privileged host reboot is not executed from the remote MCP service. The remote side may only create a pending typed request. Privilege escalation occurs only from the separate owner-local TUI launched in the user's interactive terminal.

## Acceptance requirements

- Request creation alone must never reboot the node.
- The exact command and reason must be visible before approval.
- Approval must fail if the request changed or expired.
- Active Work Session workflow interlocks block reboot.
- The TUI must require a second explicit host-reboot confirmation.
- The sudo command must use fixed argv and no shell interpolation.
- After systemd accepts the reboot job, normal Direct Node/systemd startup must restore RWMCP and the secure tunnel after boot.
