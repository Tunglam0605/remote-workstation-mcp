# Transport providers

Remote Workstation MCP separates **how a client reaches the workstation** from **what that client is allowed to do**.

The transport layer must never become a second policy engine. Its responsibilities are connection lifecycle, protocol framing and, where applicable, establishing an authenticated request principal. Workspace policy, permission leases, executable/host allowlists and tool gates remain inside the workstation core.

## Provider contract

A transport provider exposes a small runtime contract:

```text
TransportProvider
├── descriptor
│   ├── id
│   ├── protocol
│   ├── exposure
│   ├── authentication
│   └── endpoint (when applicable)
└── start(serverFactory)
```

The MCP `serverFactory` is the same regardless of provider, so adding a tunnel/relay must not change filesystem, Git, process, SSH or future engineering adapters.

## Current providers

### `stdio-local`

- protocol: stdio
- exposure: local process boundary
- intended for local MCP-aware clients
- fastest path because there is no network relay
- no HTTP bearer principal; local fallback client profile and owner policy still apply

### `http-loopback`

- protocol: MCP Streamable HTTP
- bind: `127.0.0.1` only
- default endpoint: `http://127.0.0.1:8765/mcp`
- optional bearer authentication maps the request to a scoped principal
- intended for local clients and as the private origin behind a separately authenticated secure connector

The provider reports its non-secret ID and authentication mode from `/` and `/healthz` for diagnostics.

## Future remote providers

A future OpenAI secure tunnel, Cloudflare-managed path, direct HTTPS gateway or other relay should implement the same boundary:

```text
ChatGPT Web / remote MCP client
          |
          | authenticated remote connection
          v
   transport provider / gateway
          |
          | request principal + MCP request
          v
   workstation PolicyEngine
          |
          v
       typed tools
```

A relay URL or successful tunnel connection is **not authorization**. Before a tool executes, a remote path must establish a principal that can be mapped to workstation scopes. `workstation.full_control` still cannot bypass the local owner lease or feature gates.

## Security requirements for remote providers

Any remote provider added to this project must satisfy all of these constraints:

- no unauthenticated public workstation endpoint;
- no implicit permission escalation based on tunnel/provider identity alone;
- credentials are never exposed as MCP tools or tool output;
- principal identity is request-scoped and reaches the existing audit/policy boundary;
- revocation/reconnect behavior fails closed;
- request size, timeouts and connection lifetime are bounded;
- health endpoints do not expose secrets;
- transport code cannot rewrite owner policy or permission leases;
- local stdio/loopback paths remain available and do not require a cloud relay.

## Why transport is separate from optional coding agents

Codex, Claude, OpenHands or another coding agent is an execution/delegation backend, not a network transport. Direct ChatGPT control follows:

```text
ChatGPT -> transport -> Remote Workstation MCP -> workstation
```

Optional delegation follows a separate branch:

```text
ChatGPT -> Remote Workstation MCP -> optional agent worker
```

The workstation remains usable even when an optional coding-agent provider is unavailable, rate-limited or out of tokens.
