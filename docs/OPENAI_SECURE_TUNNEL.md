# OpenAI Secure MCP Tunnel

Remote Workstation MCP v0.7.0 can connect a private workstation to ChatGPT, Codex, the Responses API, or other OpenAI-hosted MCP consumers through OpenAI's Secure MCP Tunnel without opening the workstation MCP port to the public Internet.

The workstation MCP remains bound to `127.0.0.1`. The tunnel is an **outbound-only connection provider** above the local Streamable HTTP transport; it does not replace the workstation policy, lease, audit, path, process, or SSH security boundaries.

## Trust boundary

```text
ChatGPT / OpenAI-hosted MCP consumer
              |
      OpenAI Secure MCP Tunnel
              |
       tunnel-client sidecar
              |
 Authorization: Bearer <ephemeral local token>
              |
      127.0.0.1:8765/mcp
              |
 authenticated request principal
              |
 policy -> lease -> audit -> workstation adapters
```

The supervisor creates a fresh local MCP bearer token for each run unless the owner explicitly provides `RWMCP_HTTP_BEARER_TOKEN`. The token is passed to `tunnel-client` only through `RWMCP_TUNNEL_AUTH` and the generated tunnel profile stores only `env:RWMCP_TUNNEL_AUTH`, never the token itself.

`CONTROL_PLANE_API_KEY` is needed by `tunnel-client`, but the supervisor removes `CONTROL_PLANE_API_KEY`, `OPENAI_ADMIN_KEY`, `OPENAI_API_KEY`, and `RWMCP_TUNNEL_AUTH` from the environment of the MCP child process. This keeps OpenAI control-plane credentials outside the workstation MCP process boundary.

## OpenAI prerequisites

Create or select a Secure MCP Tunnel in OpenAI Platform and obtain:

- `CONTROL_PLANE_TUNNEL_ID` — the tunnel id, normally beginning with `tunnel_`.
- `CONTROL_PLANE_API_KEY` — a runtime API key whose principal has Tunnels **Read** and **Use** permissions.

Tunnel management and runtime API keys are separate from workstation permissions. An OpenAI tunnel being connected does not grant `full_control`, raw shell, host filesystem, or administrator rights.

Useful OpenAI setup pages:

- Tunnels: `https://platform.openai.com/settings/organization/tunnels`
- Runtime API keys: `https://platform.openai.com/settings/organization/api-keys`
- ChatGPT connector settings: `https://chatgpt.com/#settings/Connectors`

## Windows: supported first-use path

First install and validate the Remote Workstation runtime:

```powershell
git checkout v0.7.0
npm run setup:windows
```

Install the pinned official OpenAI tunnel-client package:

```powershell
npm run openai:tunnel:install:windows
```

The installer downloads the official OpenAI `tunnel-client` v0.0.14 Windows AMD64 release asset and verifies this pinned SHA-256 before extraction:

```text
784ab8da7b5a88f0109f1fd8aaf0a1c86067430b896dddf307ef7e3cc49fa1a5
```

The binary is placed under:

```text
runtime\openai-tunnel\tunnel-client.exe
```

No OpenAI runtime API key or MCP bearer token is persisted by the installer.

Set the tunnel id and runtime key only in the PowerShell session that will run the connection:

```powershell
$env:CONTROL_PLANE_TUNNEL_ID = "tunnel_0123456789abcdef0123456789abcdef"
$env:CONTROL_PLANE_API_KEY = "<runtime-api-key>"
```

Start the paired MCP + tunnel supervisor:

```powershell
npm run start:openai:windows
```

The supervisor performs this sequence:

1. Starts Remote Workstation MCP on loopback with bearer authentication forced on.
2. Waits for `http://127.0.0.1:8765/healthz`.
3. Generates a tunnel-client profile containing only environment references for secrets.
4. Runs `tunnel-client doctor --profile-file ... --explain`.
5. Starts `tunnel-client run --profile-file ...`.
6. Waits for the tunnel client's `/readyz` endpoint before reporting the connection ready.
7. Stops both child processes together when either one exits or the owner presses `Ctrl+C`.

The default authenticated scope set for the tunnel principal is:

```text
workstation.read,workstation.write,workstation.execute
```

Override it only when required:

```powershell
$env:RWMCP_HTTP_SCOPES = "workstation.read,workstation.write,workstation.execute"
```

Do not add `workstation.full_control` merely to make setup easier. Full-control tools still require the corresponding authenticated scope **plus** an owner-issued, time-limited client-bound lease **plus** each explicit local dangerous-feature gate.

## Linux and other platforms

The connection supervisor is cross-platform. Install a supported `tunnel-client` binary using OpenAI's documented installation path, then either put `tunnel-client` in `PATH` or set:

```bash
export RWMCP_OPENAI_TUNNEL_CLIENT=/absolute/path/to/tunnel-client
export CONTROL_PLANE_TUNNEL_ID=tunnel_0123456789abcdef0123456789abcdef
export CONTROL_PLANE_API_KEY='<runtime-api-key>'
npm run build
npm run start:openai
```

The Windows installer is intentionally separate because release asset verification and extraction are platform-specific.

## Generated runtime files

The connection provider uses `runtime/openai-tunnel/` by default:

```text
profile.yaml              # no API key or bearer token literal
health-url                # tunnel-client local health URL
runtime/tunnel logs       # operator diagnostics
```

The generated profile points the `main` MCP channel at `http://127.0.0.1:8765/mcp` and injects `Authorization` for both normal MCP requests and discovery/probe requests through `env:RWMCP_TUNNEL_AUTH`.

The directory can be changed with `RWMCP_OPENAI_TUNNEL_DIR`; the tunnel binary can be overridden with `RWMCP_OPENAI_TUNNEL_CLIENT`.

## ChatGPT connection

Only configure the ChatGPT connector after `tunnel-client` reports ready. Keep the supervisor running for connector discovery and every subsequent MCP call.

The exact ChatGPT/Platform UI may evolve independently of this repository. The supported connection contract on the workstation side is the OpenAI Secure MCP Tunnel id + runtime key + outbound `tunnel-client` daemon; do not expose `127.0.0.1:8765` through router port-forwarding or a generic unauthenticated public reverse proxy.

## Failure handling

If startup fails, inspect the `tunnel-client doctor` output first. Common causes are:

- invalid or missing `CONTROL_PLANE_TUNNEL_ID`;
- invalid runtime API key or missing Tunnels Read/Use permissions;
- unsupported/old tunnel-client binary;
- local port 8765 already in use;
- tunnel control-plane/network access blocked by firewall or proxy policy;
- local policy/config missing because `setup:windows` or the equivalent local setup was not completed.

A failed tunnel does not cause the MCP server to bind publicly. The supervisor tears down the paired child process when startup cannot reach readiness.
