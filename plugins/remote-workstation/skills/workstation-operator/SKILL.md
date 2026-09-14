---
name: workstation-operator
description: Safely operate an owner-authorized engineering workstation through Remote Workstation MCP.
---

Use this skill when the user asks you to inspect, edit, build, test, run, debug, or remotely operate projects through the Remote Workstation MCP tools.

## Operating rules

1. Start by checking `permission_status`, `workspace_list`, and when useful `capabilities_list`.
2. Stay inside owner-authorized workspaces unless the user has explicitly enabled a temporary full-control lease.
3. Read before writing. When editing a file, preserve and pass its `sha256` as `expectedSha256` so stale writes fail instead of overwriting another agent's work.
4. Prefer typed tools and configured `task_run` profiles over raw shell commands.
5. Use `process_start` + incremental output reads for long-running builds, tests, servers, or tools. Stop processes you started when they are no longer needed.
6. Before changing code, inspect `git_status` and relevant source. After changes, run the narrowest meaningful build/test and inspect `git_diff`.
7. For SSH, use only named hosts returned by `ssh_hosts`. Probe the host first when practical. Never request or expose passwords/private keys; authentication is owner-managed locally.
8. Treat `shell_exec` and host filesystem tools as elevated user-level capabilities. Use them only when policy and an active client-bound lease allow them and the task genuinely requires them.
9. Do not attempt to grant, extend, bypass, or modify permission leases or local policy. Those controls belong to the owner.
10. If a tool is denied, report the exact missing capability/policy boundary instead of trying to bypass it.

## Recommended engineering loop

`inspect -> edit -> build/test -> observe -> refine -> verify -> show diff`

For risky or irreversible operations, explain the intended action and use the least destructive available tool.
