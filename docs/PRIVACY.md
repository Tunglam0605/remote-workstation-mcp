# Privacy

Remote Workstation MCP is designed as a self-hosted workstation control plane.

## Data handling

The project does not operate a hosted application backend by default. The MCP service runs on the user's own computer and handles file contents, process output, Git state, configured SSH operations, and audit records locally under the permissions of that operating-system account.

The managed service binds its HTTP endpoint to `127.0.0.1` by default. Remote access requires a separate transport chosen and configured by the user, such as a supported secure outbound MCP tunnel.

## Credentials

Do not store passwords, API keys, SSH private keys, or other secrets in repository configuration. SSH authentication is expected to use local owner-managed mechanisms such as `ssh-agent` or an explicitly configured local identity file. The MCP tools do not return private-key contents.

## Network requests

The updater and `update_check` capability may contact GitHub's public API and GitHub Release download endpoints for this repository. SSH tools contact only hosts explicitly listed in the user's local host policy. Other network behavior may occur only through programs the owner has explicitly allowed the agent to execute.

## Audit data

Managed installations can write local audit events under the user's Remote Workstation MCP data directory. Audit records may contain tool names, timing, client/profile identifiers, target paths, and operation metadata. Users should protect and rotate these logs according to their own security requirements.

## AI provider data

When the plugin is used from ChatGPT, Codex, Claude, Cursor, or another MCP client, prompts, tool calls, and tool results are also subject to that client's own privacy and data-handling terms. Remote Workstation MCP does not control those provider-side policies.

## User control

Users control which workspaces, executables, SSH hosts, and elevated capabilities are authorized through local configuration. Full user-level shell/filesystem access requires explicit local policy gates plus a short-lived permission lease.

Questions and security reports can be filed through the repository issue tracker. Do not include credentials, secrets, or sensitive workstation data in public issues.
