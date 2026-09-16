# Transport and connection providers

Remote Workstation MCP separates **how MCP is framed locally** from **how a remote/cloud product reaches that local MCP endpoint** and from **what an authenticated principal is allowed to do**.

Neither transport nor connection code is a second policy engine. Workspace policy, permission leases, executable/host allowlists, authenticated scopes, audit, path protection, and dangerous-feature gates remain inside the workstation core.

## Transport provider contract

```text
TransportProvider
├── descriptor
│   ├── id
│   ├── protocol
│   ├── exposure
│   ├── authentication
│   └── endpoint
└── start(serverFactory)
```

Current transport providers:

### `stdio-local`

- MCP over stdio;
- local process boundary;
- intended for local MCP-aware clients;
- no HTTP bearer principal; local fallback client profile and owner policy still apply.

### `http-loopback`

- MCP Streamable HTTP;
- binds to `127.0.0.1` only;
- default endpoint `http://127.0.0.1:8683/mcp`;
- optional bearer authentication establishes a request-scoped principal;
- intended for local clients and as the private origin behind a secure outbound connection provider.

The provider exposes non-secret transport/authentication metadata through `/` and `/healthz`.

## Connection provider contract

Remote reachability is deliberately modeled separately:

```text
ConnectionProvider
├── descriptor
│   ├── id
│   ├── transport
│   ├── exposure
│   ├── localEndpoint
│   └── authentication
├── start()
└── stop()
```

A connection provider may supervise a relay/tunnel sidecar, but it still terminates at the authenticated loopback MCP transport. Successful connectivity is never treated as authorization.

## Current outbound provider: OpenAI Secure MCP Tunnel

v0.7.0 includes `openai-secure-mcp-tunnel`:

```text
ChatGPT / OpenAI-hosted MCP consumer
              |
      OpenAI Secure MCP Tunnel
              |
       tunnel-client sidecar
              |
    Authorization: Bearer <token>
              |
      http-loopback provider
              |
 authenticated principal + scopes
              |
        PolicyEngine / audit
              |
           typed tools
```

Properties:

- outbound-only; no workstation public listener is created;
- local origin stays `127.0.0.1`;
- local MCP bearer is generated ephemerally by default;
- tunnel runtime and discovery requests both carry the bearer through `env:RWMCP_TUNNEL_AUTH`;
- generated tunnel profile stores an environment reference, not the bearer itself;
- `CONTROL_PLANE_API_KEY` is used by the tunnel sidecar but stripped from the MCP child environment;
- `tunnel-client doctor` must pass and `/readyz` must become healthy before the supervisor reports readiness;
- default authenticated workstation scopes are read/write/execute, not full-control.

See `docs/OPENAI_SECURE_TUNNEL.md`.

## Requirements for future remote connection providers

Any additional remote provider must preserve these constraints:

- no unauthenticated public workstation endpoint;
- no implicit permission escalation based on relay/provider identity;
- credentials are never exposed as MCP tools or tool output;
- principal identity and scopes reach the existing audit/policy boundary;
- revocation/reconnect behavior fails closed;
- request sizes, timeouts, process lifetime, and queues are bounded;
- health endpoints do not expose secrets;
- provider code cannot rewrite owner policy or permission leases;
- local stdio/loopback paths remain usable without a cloud dependency.

`workstation.full_control` never bypasses the local owner lease or explicit feature gates.

## Why transport/connection is separate from optional coding agents

Codex, Claude, OpenHands, or another coding agent is an execution/delegation backend, not a network transport or connection provider.

Direct control:

```text
ChatGPT -> connection (when remote) -> transport -> Remote Workstation MCP -> workstation
```

Optional delegation:

```text
ChatGPT -> Remote Workstation MCP -> optional agent worker
```

The workstation remains usable even when an optional external coding-agent provider is unavailable, rate-limited, or out of tokens.
