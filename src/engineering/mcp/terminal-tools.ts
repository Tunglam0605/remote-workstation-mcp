import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AppContext } from '../../context.js';
import { audited } from '../../security/audit.js';

const result = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  structuredContent: value as Record<string, unknown>
});

export function registerEngineeringTerminalTools(server: McpServer, ctx: AppContext): void {
  server.registerTool('terminal_start', {
    description: 'Start a true PTY/ConPTY terminal in an authorized workspace. The requested executable remains subject to process.allowExecutables.',
    inputSchema: z.object({ workspace: z.string(), program: z.string().min(1), args: z.array(z.string()).max(500).default([]), cwd: z.string().default('.'), cols: z.number().int().min(20).max(500).default(120), rows: z.number().int().min(5).max(200).default(30), workSessionId: z.string().uuid().optional() }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ workspace, program, args, cwd, cols, rows, workSessionId }) => result(await audited(ctx.audit, 'terminal_start', workspace, () => ctx.runInWorkSession(workSessionId, () => ctx.engineering.terminals.start(workspace, program, args, cwd, cols, rows)))));

  server.registerTool('terminal_read', {
    description: 'Read incremental output from a caller-owned PTY/ConPTY session.',
    inputSchema: z.object({ id: z.string().uuid(), cursor: z.number().int().nonnegative().default(0), workSessionId: z.string().uuid().optional() }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ id, cursor, workSessionId }) => result(await audited(ctx.audit, 'terminal_read', undefined, () => ctx.runInWorkSession(workSessionId, () => ctx.engineering.terminals.read(id, cursor)))));

  server.registerTool('terminal_write', {
    description: 'Write bounded interactive input to a caller-owned PTY/ConPTY session.',
    inputSchema: z.object({ id: z.string().uuid(), data: z.string(), workSessionId: z.string().uuid().optional() }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ id, data, workSessionId }) => result(await audited(ctx.audit, 'terminal_write', undefined, () => ctx.runInWorkSession(workSessionId, () => ctx.engineering.terminals.write(id, data)))));

  server.registerTool('terminal_resize', {
    description: 'Resize a caller-owned PTY/ConPTY terminal.',
    inputSchema: z.object({ id: z.string().uuid(), cols: z.number().int().min(20).max(500), rows: z.number().int().min(5).max(200), workSessionId: z.string().uuid().optional() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ id, cols, rows, workSessionId }) => result(await audited(ctx.audit, 'terminal_resize', undefined, () => ctx.runInWorkSession(workSessionId, () => ctx.engineering.terminals.resize(id, cols, rows)))));

  server.registerTool('terminal_stop', {
    description: 'Stop a caller-owned PTY/ConPTY terminal session.',
    inputSchema: z.object({ id: z.string().uuid(), workSessionId: z.string().uuid().optional() }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ id, workSessionId }) => result(await audited(ctx.audit, 'terminal_stop', undefined, () => ctx.runInWorkSession(workSessionId, () => ctx.engineering.terminals.stop(id)))));
}
