# Remote Workstation MCP

A security-focused MCP agent that lets AI clients such as ChatGPT operate approved engineering workspaces on a personal workstation: inspect and edit code, run builds/tests, supervise processes, use installed development tools, and later access explicitly authorized SSH hosts.

> **Alpha software.** It can modify files and execute programs. Start with a disposable workspace and least-privilege policy.

## Design goals

- **Safe by default, powerful when authorized.**
- Owner policy is local and cannot be changed through MCP tools.
- Filesystem access is workspace-scoped with symlink/traversal protection.
- Commands use executable + argv with `shell: false`; no raw shell in v0.1.
- Child-process environment is minimized to reduce credential leakage.
- Long-running programs are managed as sessions with bounded output and timeout.
- The core stays generic; STM32, ROS 2, GDB, OpenOCD, Docker and other engineering tools are adapters on top.

## v0.1 tools

| Tool | Purpose |
| --- | --- |
| `system_info` | Non-secret host information |
| `workspace_list` | Authorized workspaces |
| `fs_list` | List workspace directory |
| `fs_read` | Read UTF-8 file + SHA-256 |
| `fs_write` | Create/overwrite text file |
| `fs_patch` | Exact deterministic text replacement |
| `git_status` | Read-only repository status |
| `git_diff` | Read-only diff |
| `process_start` | Start allowlisted executable without shell |
| `process_read` | Read process state/output |
| `process_list` | List managed processes |
| `process_stop` | Stop managed process |

## Requirements

- Node.js 22+
- npm
- Git for Git tools
- An MCP client, or OpenAI Secure MCP Tunnel for ChatGPT remote access

## Install

```bash
git clone https://github.com/Tunglam0605/remote-workstation-mcp.git
cd remote-workstation-mcp
npm install
cp config/policy.example.yaml config/policy.yaml
```

Edit `config/policy.yaml` and point the workspace root at a directory you intentionally want the agent to access.

Then verify:

```bash
npm run typecheck
npm test
npm run build
```

## Run locally

### stdio

```bash
npm run start:stdio
```

### loopback Streamable HTTP

```bash
npm start
# MCP endpoint: http://127.0.0.1:8765/mcp
# Health:       http://127.0.0.1:8765/healthz
```

The HTTP listener is intentionally bound to loopback in v0.1.

## Connect to ChatGPT with Secure MCP Tunnel

The recommended architecture keeps the workstation MCP server private and lets the OpenAI tunnel client make the outbound connection.

```text
ChatGPT
   |
   v
OpenAI Secure MCP Tunnel
   ^
   | outbound HTTPS
   |
Your workstation
   +-- tunnel-client
   +-- remote-workstation-mcp (stdio or localhost)
```

1. Build this repository and confirm it works locally.
2. Install OpenAI's official `tunnel-client` and run `tunnel-client help quickstart`.
3. Create/select an OpenAI tunnel and a restricted runtime API key with **Tunnels Read + Use**.
4. For stdio, initialize a tunnel profile with the absolute command to this server, for example:

```bash
tunnel-client init \
  --sample sample_mcp_stdio_local \
  --profile remote-workstation \
  --tunnel-id YOUR_TUNNEL_ID \
  --mcp-command "node /absolute/path/to/remote-workstation-mcp/dist/cli.js --stdio"

tunnel-client doctor --profile remote-workstation --explain
tunnel-client run --profile remote-workstation
```

5. In ChatGPT plugin/connector settings, choose a **Tunnel** connection and select that tunnel while `tunnel-client` is healthy.

Do not put runtime or admin API keys in this repository. Keep them in your local secret store/environment as recommended by the tunnel client documentation.

## Example policy

```yaml
version: 1
mode: workspace
workspaces:
  - id: projects
    root: /home/you/Projects
    readOnly: false
filesystem:
  maxReadBytes: 1048576
  maxWriteBytes: 1048576
process:
  allowExecutables: [git, node, npm, python3, cmake, ninja, make]
  inheritEnv: [PATH, HOME, LANG, TERM, TMPDIR]
  maxOutputBytes: 262144
  maxRuntimeMs: 600000
```

## Security boundary

The model is **not** the security authority. Every request is revalidated locally by policy and adapters. See [Security](docs/SECURITY.md) and [Threat model](docs/THREAT_MODEL.md).

The long-term project goal includes owner-approved, time-limited elevation up to full administrative control. That is intentionally not enabled by the v0.1 default tool surface.

## Architecture and roadmap

- [Architecture](docs/ARCHITECTURE.md)
- [Security](docs/SECURITY.md)
- [Threat model](docs/THREAT_MODEL.md)
- [Roadmap](docs/ROADMAP.md)
- [Contributing](CONTRIBUTING.md)

## License

Apache-2.0
