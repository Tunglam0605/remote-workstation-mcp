# OpenAI Secure MCP Tunnel

Remote Workstation MCP v0.7.2 can connect a private workstation to ChatGPT, Codex, the Responses API, or other OpenAI-hosted MCP consumers through OpenAI's Secure MCP Tunnel without opening the workstation MCP port to the public Internet.

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
git checkout v0.7.2
npm run setup:windows
npm run setup:web:windows
```

The Setup Console can configure the loopback MCP port, tunnel ID, organization ID, Cloudflare preference, install the verified official tunnel-client, and optionally store the runtime API key with Windows DPAPI.

Non-secret values are persisted outside the repository at:

```text
%LOCALAPPDATA%\RemoteWorkstationMCP\settings.json
```

The optional runtime key is stored separately as a current-user DPAPI blob. It is not written to `settings.json`, the repository, the generated tunnel profile, or command-line arguments.

The official tunnel-client Windows AMD64 installer remains available directly:

```powershell
npm run openai:tunnel:install:windows
```

After setup, start the configured path with:

```powershell
npm run start:openai:windows
```

Explicit environment variables still override persisted setup values for one-off sessions.

## Cloudflared behavior

Managed Cloudflare runtime material is **optional**. v0.7.2 does not require it by default because a normal logical tunnel may not have managed Cloudflare runtime material provisioned.

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

If the port is persisted by the Setup Console, inspect the launcher output or `%LOCALAPPDATA%\RemoteWorkstationMCP\settings.json` to identify it.

Local MCP health example:

```powershell
Invoke-RestMethod http://127.0.0.1:8683/healthz
```

Expected tunnel mode includes:

```text
ok       : True
version  : 0.7.2
httpAuth : bearer
```

Tunnel-client health:

```powershell
.\runtime\openai-tunnel\tunnel-client.exe health `
  --url-file .\runtime\openai-tunnel\health-url
```

Successful startup requires both `Healthz: PASS` and `Readyz: PASS`.

## ChatGPT Web connection

Only configure the ChatGPT custom app after `tunnel-client` reports `/readyz` as HTTP 200. Keep the supervisor running for connector discovery and subsequent MCP calls.

For an eligible ChatGPT workspace:

1. enable Developer Mode according to workspace policy;
2. open ChatGPT Apps/custom app settings;
3. create a custom app;
4. select **Connection: Tunnel**;
5. select the authorized tunnel or paste its `tunnel_...` ID;
6. review the discovered tool set before wider workspace publication.

As of September 2026, OpenAI documents full custom MCP apps with write/modify for ChatGPT Business, Enterprise and Edu on the web. Workstation/tunnel readiness is independent of that product entitlement.

See [ChatGPT Web](CHATGPT_WEB.md).

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

The local web Setup Console can run cross-platform, but persistent API-key storage is currently Windows-DPAPI-specific. On other platforms keep the runtime key in a suitable OS secret manager or the process environment.

## Generated runtime files

The provider uses `runtime/openai-tunnel/` by default:

```text
profile.yaml              # no API key or bearer-token literal
health-url                # tunnel-client local health URL
tunnel-client.ndjson      # operator diagnostics
```

The directory can be changed with `RWMCP_OPENAI_TUNNEL_DIR`; the tunnel binary can be overridden with `RWMCP_OPENAI_TUNNEL_CLIENT`.

## Failure handling

- `doctor` passes but `run` fails with `401/403`: verify runtime-key principal Tunnels Read + Use and organization/workspace association.
- `404 Managed Cloudflare tunnel runtime material not found`: leave `CLOUDFLARED_MANAGED=false` unless managed material has actually been provisioned.
- `EADDRINUSE`: use the Setup Console's free-port recommendation or choose another `RWMCP_PORT`.
- `EACCES`: choose a non-reserved Windows port.
- local MCP returns `401` while tunnel mode is starting: expected; bearer authentication is active.
- `Readyz` is not 200: inspect `runtime/openai-tunnel/tunnel-client.ndjson` and the local tunnel-client UI URL from `health-url`.

A failed tunnel never causes Remote Workstation MCP to bind publicly.
