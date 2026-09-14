# Client integrations

Remote Workstation MCP is intentionally AI-vendor-neutral. The same server can be used by ChatGPT, Codex, Claude Code, Cursor, VS Code integrations and custom MCP clients as long as the client supports MCP.

## Transport choices

| Scenario | Recommended transport |
| --- | --- |
| AI client runs on the same workstation | stdio |
| Local application needs an HTTP MCP endpoint | loopback Streamable HTTP |
| Cloud AI client needs the workstation | secure outbound tunnel/connector supported by that client |

Do not expose `127.0.0.1:8765` through raw public port-forwarding.

## Common stdio command

After a local build:

```bash
RWMCP_POLICY=/absolute/path/to/policy.yaml \
RWMCP_HOSTS=/absolute/path/to/hosts.yaml \
RWMCP_CLIENT_ID=my-agent \
RWMCP_CLIENT_TYPE=mcp \
node /absolute/path/to/remote-workstation-mcp/dist/cli.js --stdio
```

For a managed Linux install:

```text
command: node
args:
  - ~/.local/share/remote-workstation-mcp/current/dist/cli.js
  - --stdio
```

Use absolute paths in client configuration when the client does not expand `~`.

## Dedicated client profiles

Give each persistent integration its own audit/profile ID, for example:

```text
chatgpt-main
codex-main
claude-main
cursor-main
```

Set:

```text
RWMCP_CLIENT_ID=<profile-id>
RWMCP_CLIENT_TYPE=<client-family>
```

These tags improve auditability. They are not, by themselves, cryptographic authentication. A full-control lease can be bound to one dedicated profile ID so another profile does not inherit the lease accidentally.

## ChatGPT

For local-only ChatGPT deployments where a supported secure MCP tunnel is available, keep the workstation MCP bound to loopback and connect the cloud side through the outbound tunnel. The workstation policy remains the authorization boundary.

Recommended profile:

```text
RWMCP_CLIENT_ID=chatgpt-main
RWMCP_CLIENT_TYPE=chatgpt
```

After adding or changing MCP tools, refresh/review the connector/tool definitions in ChatGPT if the product UI requires it.

## Codex

Use a stdio MCP profile when Codex runs locally on the workstation. Point the MCP client configuration at the installed `dist/cli.js --stdio` command and give it a dedicated profile ID.

Recommended profile:

```text
RWMCP_CLIENT_ID=codex-main
RWMCP_CLIENT_TYPE=codex
```

Keep Git write/push outside the broad default policy until you intentionally add those capabilities. Use SHA-256 preconditions when multiple agents may edit the same file.

## Claude Code / Claude Desktop

Configure Remote Workstation MCP as a local stdio MCP server using the same command. A dedicated profile is recommended:

```text
RWMCP_CLIENT_ID=claude-main
RWMCP_CLIENT_TYPE=claude
```

Client configuration syntax changes over time, so prefer the current MCP-server configuration workflow documented by the installed Claude client rather than copying old CLI flags from third-party tutorials.

## Cursor / VS Code / other MCP clients

Use the client's MCP server configuration UI/file and register the same stdio command. Recommended profile IDs should be unique per long-lived client installation.

## HTTP mode

Run:

```bash
npm start
```

The server exposes:

```text
http://127.0.0.1:8765/mcp
http://127.0.0.1:8765/healthz
```

HTTP intentionally stays on loopback. If a remote client needs access, use a secure authenticated transport layer rather than changing the listen address casually.

## Multi-agent editing rules

When two or more clients share a workspace:

1. read a file before modifying it;
2. retain the returned SHA-256;
3. pass it as `expectedSha256` to overwrite/patch operations;
4. treat a hash conflict as a re-read/review event;
5. avoid giving several agents a raw-shell/full-control lease simultaneously;
6. use separate Git worktrees for larger concurrent tasks once worktree automation is available.

## Capability discovery

Every client should begin a session with:

```text
capabilities_list
```

and optionally:

```text
tool_discover
permission_status
workspace_list
ssh_hosts
```

This lets the client adapt to the actual workstation instead of assuming tools or permissions exist.
