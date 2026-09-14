# OpenAI Secure MCP Tunnel

Remote Workstation MCP v0.7.1 can connect a private workstation to ChatGPT, Codex, the Responses API, or other OpenAI-hosted MCP consumers through OpenAI's Secure MCP Tunnel without opening the workstation MCP port to the public Internet.

The workstation MCP remains bound to `127.0.0.1`. The tunnel is an **outbound-only connection provider** above the local Streamable HTTP transport; it does not replace workstation policy, leases, audit, path protection, process ownership, Git/LSP adapters, or SSH controls.

## Trust boundary

```text
ChatGPT / OpenAI-hosted MCP consumer
              |
      OpenAI Secure MCP Tunnel
              |
         tunnel-client
              |
 Authorization: Bearer <ephemeral local token>
              |
  127.0.0.1:<RWMCP_PORT>/mcp
              |
 authenticated request principal
              |
 policy -> lease -> audit -> workstation adapters
```

The supervisor creates a fresh local MCP bearer token for each run unless the owner explicitly provides `RWMCP_HTTP_BEARER_TOKEN`. The generated tunnel profile stores only the environment reference `env:RWMCP_TUNNEL_AUTH`, never the bearer itself.

`CONTROL_PLANE_API_KEY` is required by `tunnel-client`, but the supervisor removes `CONTROL_PLANE_API_KEY`, `OPENAI_ADMIN_KEY`, `OPENAI_API_KEY`, and `RWMCP_TUNNEL_AUTH` from the MCP child environment.

## OpenAI prerequisites

Create or select a Secure MCP Tunnel in OpenAI Platform and obtain:

- `CONTROL_PLANE_TUNNEL_ID` — tunnel id beginning with `tunnel_`.
- `CONTROL_PLANE_API_KEY` — runtime API key whose principal has Tunnels **Read** and **Use**.
- `CONTROL_PLANE_ORGANIZATION_ID` — recommended when the tunnel is organization-scoped or the account can address multiple organizations.

Useful setup pages:

- Tunnels: `https://platform.openai.com/settings/organization/tunnels`
- Runtime API keys: `https://platform.openai.com/settings/organization/api-keys`
- ChatGPT connector settings: `https://chatgpt.com/#settings/Connectors`

## Windows first-use path

```powershell
cd "$HOME\Documents\remote-workstation-mcp"
git checkout v0.7.1
npm run setup:windows
npm run openai:tunnel:install:windows
```

The installer downloads the official OpenAI `tunnel-client` v0.0.14 Windows AMD64 release asset, verifies the pinned SHA-256, and installs it under:

```text
runtime\openai-tunnel\tunnel-client.exe
```

No OpenAI runtime API key or MCP bearer token is persisted by the installer.

Choose a loopback port that is not already in use. Example:

```powershell
$env:RWMCP_PORT = "8683"
$env:CONTROL_PLANE_TUNNEL_ID = "tunnel_0123456789abcdef0123456789abcdef"
$env:CONTROL_PLANE_ORGANIZATION_ID = "org_example"
$env:CONTROL_PLANE_API_KEY = "<runtime-api-key>"
npm run start:openai:windows
```

The launcher prints the actual configured port rather than a hard-coded default.

## Cloudflared behavior

Managed Cloudflare runtime material is **optional**. v0.7.1 does not require it by default because a normal logical tunnel may not have managed Cloudflare runtime material provisioned.

The generated profile contains:

```yaml
cloudflared:
  managed: false
```

The CLI also defaults `CLOUDFLARED_MANAGED=false` unless the owner explicitly set it. To opt in for a tunnel that is known to have managed Cloudflare runtime material:

```powershell
$env:CLOUDFLARED_MANAGED = "true"
```

If the control plane returns `404 Managed Cloudflare tunnel runtime material not found`, keep `CLOUDFLARED_MANAGED=false`; this is not an MCP authentication failure.

## Startup sequence

The supervisor:

1. Starts Remote Workstation MCP on `127.0.0.1:<RWMCP_PORT>` with bearer authentication forced on.
2. Waits for `/healthz`.
3. Generates a tunnel-client profile containing environment references for secrets.
4. Runs `tunnel-client doctor --profile-file ... --explain`.
5. Starts `tunnel-client run --profile-file ...`.
6. Waits for the tunnel client's `/readyz` endpoint.
7. Stops MCP and tunnel together when either process exits or the owner presses `Ctrl+C`.

The default authenticated tunnel scopes are:

```text
workstation.read,workstation.write,workstation.execute
```

Do not add `workstation.full_control` just to make setup easier. Full-control tools still require the authenticated scope, an owner-issued time-limited client-bound lease, and the relevant local dangerous-feature gate.

## Verify readiness

Local MCP health:

```powershell
Invoke-RestMethod http://127.0.0.1:$env:RWMCP_PORT/healthz
```

Expected tunnel mode includes:

```text
ok       : True
version  : 0.7.1
httpAuth : bearer
```

Tunnel-client health:

```powershell
.\runtime\openai-tunnel\tunnel-client.exe health `
  --url-file .\runtime\openai-tunnel\health-url
```

Successful startup requires both `Healthz: PASS` and `Readyz: PASS`.

## Linux and other platforms

Install a supported `tunnel-client` binary, put it in `PATH` or set `RWMCP_OPENAI_TUNNEL_CLIENT`, then run:

```bash
export RWMCP_OPENAI_TUNNEL_CLIENT=/absolute/path/to/tunnel-client
export CONTROL_PLANE_TUNNEL_ID=tunnel_0123456789abcdef0123456789abcdef
export CONTROL_PLANE_ORGANIZATION_ID=org_example
export CONTROL_PLANE_API_KEY='<runtime-api-key>'
export RWMCP_PORT=8765
npm run build
npm run start:openai
```

## Generated runtime files

The provider uses `runtime/openai-tunnel/` by default:

```text
profile.yaml              # no API key or bearer-token literal
health-url                # tunnel-client local health URL
tunnel-client.ndjson      # operator diagnostics
```

The directory can be changed with `RWMCP_OPENAI_TUNNEL_DIR`; the tunnel binary can be overridden with `RWMCP_OPENAI_TUNNEL_CLIENT`.

## ChatGPT connection

Only configure the ChatGPT connector after `tunnel-client` reports `/readyz` as HTTP 200. Keep the supervisor running for connector discovery and every subsequent MCP call.

Do not expose the workstation loopback port through router port-forwarding or an unauthenticated public reverse proxy.

## Failure handling

- `doctor` passes but `run` fails with `401/403`: verify runtime-key principal Tunnels Read + Use and organization/workspace association.
- `404 Managed Cloudflare tunnel runtime material not found`: leave `CLOUDFLARED_MANAGED=false` unless managed material has actually been provisioned.
- `EADDRINUSE`: choose another `RWMCP_PORT`.
- `EACCES`: choose a non-reserved Windows port.
- local MCP returns `401` while tunnel mode is starting: expected; bearer authentication is active.
- `Readyz` is not 200: inspect `runtime/openai-tunnel/tunnel-client.ndjson` and the local tunnel-client UI URL from `health-url`.

A failed tunnel never causes Remote Workstation MCP to bind publicly.
