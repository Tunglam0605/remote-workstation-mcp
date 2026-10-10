# MCP tool attachment audit (Issue #241)

This is a **local/offline, read-only diagnostic**. It is not a workaround that exposes additional tools, changes an OpenAI tool surface, relaxes an allowlist or requests credentials.

## Inputs

1. **Catalog**: a JSON object copied from the authenticated `capabilities_list` structured response. The tool consumes only `version`, `actionSchemaVersion`, and `capabilities[].{id,tools,exposure.exposed}`. Only exposed capability groups count.
2. **Client**: a JSON array of exact ChatGPT tool names, or `{"names":["..."]}` (without the connector namespace prefix).
3. **MCP (optional)**: a *complete*, previously authenticated MCP `tools/list` snapshot: `{"tools":[{"name":"..."}]}` or a merged array of names. Fetch it through a separately authorized MCP client/diagnostic using existing authentication. If there is a `nextCursor`, fetch all pages and merge the names first. **Never put bearer tokens, cookies or authorization headers in these files.**

4. **Registered (optional, included within Catalog)**: A future runtime may add `registeredToolSurface` to the authenticated `capabilities_list` result. This is a name-only snapshot captured during `server.registerTool` calls for that **specific MCP server instance**. It is not protocol `tools/list`, does not imply client attachment, and may reflect a different construction-time actor than the request principal. Never substitute it for `--mcp`.

The script performs no networking and never reads authentication settings.

## Run

```text
node scripts/audit-mcp-tool-attachment.mjs --catalog catalog.json --client chatgpt.json --mcp mcp-tools.json --output audit.json
```

Omit `--mcp` if the authenticated raw listing cannot be retrieved lawfully. An incomplete comparison is recorded as `UNVERIFIED_RAW_MCP`, never as a false PASS. An output file must not already exist.

## Exit statuses

| Code | Meaning |
| --- | --- |
| 0 | PASS: all three available name surfaces agree |
| 1 | invalid input, duplicate, malformed/paginated capture or I/O error |
| 2 | FAIL: evidence of a name mismatch |
| 3 | UNVERIFIED_RAW_MCP: incomplete diagnostic, not server/client attribution |

## Attribution

- `advertisedNotMcp` nonempty: investigate **server registration / extension filtering**.
- `advertisedNotMcp` empty and `rawMcpNotClient` nonempty: investigate **client tool attachment / schema snapshot / client filtering**.
- Missing raw list: **root cause unknown**. Do not infer a client cap solely from the number of missing names.
- `clientNotRawMcp` nonempty: client may be stale or attached to another server version.

This checks discoverability by names only. It does **not** prove individual actions are executable, authorized, correct, or production-accepted. Recheck the active runtime/pack selection and run non-mutating smoke tests before declaring resolution. Any user-level connector rebind or tool-surface permission change remains owner-controlled.

## Server-instance registration instrumentation (post-PR #245 addition)

`src/mcp-registration-ledger.ts` wraps only `McpServer.registerTool` on each new server instance, retaining the original call's arguments, return and exceptions. `buildServer` installs it **before** tool registration and `capabilities_list` returns `registeredToolSurface` when the ledger is wired. No security policy, pack selection, platform filtering, handler, or tool semantics are changed.

Use `registeredToolSurface.names` to diagnose whether advertised names reached the registration API. Its absence or differences **cannot by themselves** prove that the authenticated MCP `tools/list` transport delivered (or failed to deliver) those names. The definitive attachment test still requires a complete authenticated `tools/list` and a fresh client schema snapshot. Do not mark Issue #241 resolved from unit tests or ledger output alone.

For Windows v0.70.0-dev.6, this change is source-only until a separate, owner-accepted release installs it. Do not apply it to the live dev6 runtime merely to inspect a client-tool mismatch.
