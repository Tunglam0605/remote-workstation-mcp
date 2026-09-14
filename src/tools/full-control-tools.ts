import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AppContext } from '../context.js';
import { audited } from '../security/audit.js';

const result = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  structuredContent: value as Record<string, unknown>
});

export function registerFullControlTools(server: McpServer, ctx: AppContext): void {
  server.registerTool('permission_status', {
    description: 'Report configured and effective permission mode plus any active owner-granted lease. This tool cannot grant or extend permissions.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async () => result(await audited(ctx.audit, 'permission_status', undefined, async () => ctx.policy.status())));

  server.registerTool('host_fs_list', {
    description: 'List an absolute host directory. Requires an active full-control owner lease and fullControl.allowHostFilesystem=true.',
    inputSchema: z.object({ path: z.string().min(1) }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ path }) => result({ entries: await audited(ctx.audit, 'host_fs_list', undefined, () => ctx.hostFs.list(path)) }));

  server.registerTool('host_fs_read', {
    description: 'Read an absolute UTF-8 host file. Requires an active full-control owner lease and explicit host-filesystem policy gate.',
    inputSchema: z.object({ path: z.string().min(1) }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ path }) => result(await audited(ctx.audit, 'host_fs_read', undefined, () => ctx.hostFs.read(path))));

  server.registerTool('host_fs_write', {
    description: 'Create/overwrite an absolute UTF-8 host file. Requires full-control owner lease and explicit host-filesystem gate. Use expectedSha256 when replacing a file previously read.',
    inputSchema: z.object({
      path: z.string().min(1),
      content: z.string(),
      overwrite: z.boolean().default(false),
      expectedSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional()
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ path, content, overwrite, expectedSha256 }) => result(await audited(ctx.audit, 'host_fs_write', undefined, () => ctx.hostFs.write(path, content, overwrite, expectedSha256))));

  server.registerTool('shell_exec', {
    description: 'Execute a raw local shell command. This is intentionally powerful and only works with an active full-control owner lease plus fullControl.allowRawShell=true.',
    inputSchema: z.object({ command: z.string().min(1), cwd: z.string().optional(), timeoutMs: z.number().int().positive().max(24 * 60 * 60 * 1000).optional() }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  }, async ({ command, cwd, timeoutMs }) => result(await audited(ctx.audit, 'shell_exec', undefined, () => ctx.fullControl.shell(command, cwd, timeoutMs))));
}
