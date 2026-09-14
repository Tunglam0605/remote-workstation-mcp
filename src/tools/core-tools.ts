import os from 'node:os';
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AppContext } from '../context.js';
import { CAPABILITIES, SERVER_VERSION } from '../capabilities.js';
import { audited } from '../security/audit.js';

const result = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  structuredContent: value as Record<string, unknown>
});

export function registerCoreTools(server: McpServer, ctx: AppContext): void {
  server.registerTool('capabilities_list', {
    description: 'Discover workstation capabilities exposed by this MCP server and their implementation status.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async () => result(await audited(ctx.audit, 'capabilities_list', undefined, async () => ({
    server: 'remote-workstation-mcp', version: SERVER_VERSION, protocol: 'MCP', vendorNeutral: true,
    actorTag: ctx.actor,
    identityNote: 'Client tags are observability metadata; local owner policy and permission leases are the authorization authority.',
    capabilities: CAPABILITIES
  }))));

  server.registerTool('system_info', {
    description: 'Return non-secret host OS, CPU, memory and uptime information.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async () => result(await audited(ctx.audit, 'system_info', undefined, async () => ({
    serverVersion: SERVER_VERSION,
    platform: os.platform(), release: os.release(), arch: os.arch(), hostname: os.hostname(),
    cpuCount: os.cpus().length, totalMemoryBytes: os.totalmem(), freeMemoryBytes: os.freemem(), uptimeSeconds: os.uptime(),
    node: process.version,
    permission: ctx.policy.status()
  }))));

  server.registerTool('tool_discover', {
    description: 'Discover common development/debug executables installed on the workstation and whether local policy allows executing them.',
    inputSchema: z.object({ extra: z.array(z.string().min(1)).max(50).default([]) }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ extra }) => result({ tools: await audited(ctx.audit, 'tool_discover', undefined, () => ctx.tools.discover(extra)) }));

  server.registerTool('update_check', {
    description: 'Check the official GitHub Releases feed for a newer Remote Workstation MCP version. This never installs an update.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true }
  }, async () => result(await audited(ctx.audit, 'update_check', undefined, () => ctx.updates.check())));

  server.registerTool('workspace_list', {
    description: 'List workspace roots authorized by the local owner policy.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async () => result(await audited(ctx.audit, 'workspace_list', undefined, async () => ctx.config.workspaces.map(ws => ({ id: ws.id, name: ws.name ?? ws.id, root: ws.root, readOnly: ws.readOnly ?? false })))));

  server.registerTool('fs_list', {
    description: 'List a directory inside an authorized workspace. Paths are workspace-relative.',
    inputSchema: z.object({ workspace: z.string(), path: z.string().default('.') }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ workspace, path }) => result(await audited(ctx.audit, 'fs_list', workspace, () => ctx.fs.list(workspace, path))));

  server.registerTool('fs_find', {
    description: 'Find files by path/name substring within an authorized workspace. Search is bounded and skips symlinks, .git and node_modules.',
    inputSchema: z.object({ workspace: z.string(), query: z.string().min(1), path: z.string().default('.'), maxResults: z.number().int().positive().max(1000).optional() }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ workspace, query, path, maxResults }) => result({ matches: await audited(ctx.audit, 'fs_find', workspace, () => ctx.search.findFiles(workspace, query, path, maxResults)) }));

  server.registerTool('fs_search_text', {
    description: 'Search UTF-8 text files within an authorized workspace and return bounded line matches.',
    inputSchema: z.object({ workspace: z.string(), query: z.string().min(1), path: z.string().default('.'), caseSensitive: z.boolean().default(false), maxResults: z.number().int().positive().max(1000).optional() }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ workspace, query, path, caseSensitive, maxResults }) => result({ matches: await audited(ctx.audit, 'fs_search_text', workspace, () => ctx.search.searchText(workspace, query, path, caseSensitive, maxResults)) }));

  server.registerTool('fs_read', {
    description: 'Read a UTF-8 text file inside an authorized workspace and return its SHA-256 for optimistic concurrency.',
    inputSchema: z.object({ workspace: z.string(), path: z.string().min(1) }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ workspace, path }) => result(await audited(ctx.audit, 'fs_read', workspace, () => ctx.fs.read(workspace, path))));

  server.registerTool('fs_write', {
    description: 'Create or overwrite a UTF-8 file. Supply expectedSha256 when overwriting a file previously read to prevent lost updates from concurrent agents.',
    inputSchema: z.object({ workspace: z.string(), path: z.string().min(1), content: z.string(), overwrite: z.boolean().default(false), expectedSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional() }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ workspace, path, content, overwrite, expectedSha256 }) => result(await audited(ctx.audit, 'fs_write', workspace, () => ctx.fs.write(workspace, path, content, overwrite, expectedSha256))));

  server.registerTool('fs_patch', {
    description: 'Deterministically replace exact text in a file. Supply the SHA-256 from fs_read to detect concurrent modification.',
    inputSchema: z.object({ workspace: z.string(), path: z.string().min(1), find: z.string().min(1), replace: z.string(), expectedOccurrences: z.number().int().positive().default(1), expectedSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional() }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ workspace, path, find, replace, expectedOccurrences, expectedSha256 }) => result(await audited(ctx.audit, 'fs_patch', workspace, () => ctx.fs.patch(workspace, path, find, replace, expectedOccurrences, expectedSha256))));

  server.registerTool('git_status', {
    description: 'Run read-only git status in an authorized workspace.',
    inputSchema: z.object({ workspace: z.string() }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ workspace }) => result({ output: await audited(ctx.audit, 'git_status', workspace, () => ctx.git.status(workspace)) }));

  server.registerTool('git_diff', {
    description: 'Run read-only git diff in an authorized workspace.',
    inputSchema: z.object({ workspace: z.string(), staged: z.boolean().default(false) }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ workspace, staged }) => result({ output: await audited(ctx.audit, 'git_diff', workspace, () => ctx.git.diff(workspace, staged)) }));

  server.registerTool('task_list', {
    description: 'List owner-defined build/test task profiles from local policy.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async () => result({ tasks: await audited(ctx.audit, 'task_list', undefined, async () => ctx.tasks.list()) }));

  server.registerTool('task_run', {
    description: 'Run an owner-defined task profile in an authorized workspace. Program execution remains subject to current permission policy.',
    inputSchema: z.object({ workspace: z.string(), task: z.string().min(1), extraArgs: z.array(z.string()).max(100).default([]) }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ workspace, task, extraArgs }) => result(await audited(ctx.audit, 'task_run', workspace, () => ctx.tasks.run(workspace, task, extraArgs))));

  server.registerTool('process_start', {
    description: 'Start an executable without a shell. Normal modes require the executable allowlist; full-control owner lease may lift that allowlist.',
    inputSchema: z.object({ workspace: z.string(), program: z.string().min(1), args: z.array(z.string()).max(500).default([]), cwd: z.string().default('.') }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ workspace, program, args, cwd }) => result(await audited(ctx.audit, 'process_start', workspace, () => ctx.processes.start(workspace, program, args, cwd))));

  server.registerTool('process_read', {
    description: 'Read current state and current bounded stdout/stderr buffers of a managed process.',
    inputSchema: z.object({ id: z.string().uuid() }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ id }) => result(ctx.processes.read(id)));

  server.registerTool('process_read_since', {
    description: 'Read only process output produced since caller-provided cursors. Returns next cursors and whether older output was truncated.',
    inputSchema: z.object({ id: z.string().uuid(), stdoutCursor: z.number().int().nonnegative().default(0), stderrCursor: z.number().int().nonnegative().default(0) }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ id, stdoutCursor, stderrCursor }) => result(ctx.processes.readSince(id, stdoutCursor, stderrCursor)));

  server.registerTool('process_list', {
    description: 'List processes started through this MCP agent.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async () => result({ processes: ctx.processes.list() }));

  server.registerTool('process_stop', {
    description: 'Stop a managed process with SIGTERM.',
    inputSchema: z.object({ id: z.string().uuid() }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ id }) => result(ctx.processes.stop(id)));
}
