import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AppContext } from '../context.js';
import { audited } from '../security/audit.js';

const result = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  structuredContent: value as Record<string, unknown>
});

export function registerInteractiveProcessTools(server: McpServer, ctx: AppContext): void {
  server.registerTool('process_write', {
    description: 'Write bounded UTF-8 input to stdin of a caller-owned running managed process. This is pipe-backed interaction, not a pseudo-terminal.',
    inputSchema: z.object({
      id: z.string().uuid(),
      input: z.string(),
      appendNewline: z.boolean().default(false)
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ id, input, appendNewline }) => result(await audited(
    ctx.audit,
    'process_write',
    undefined,
    async () => ctx.processes.write(id, input, appendNewline)
  )));

  server.registerTool('process_close_stdin', {
    description: 'Close stdin of a caller-owned managed process, allowing programs that wait for EOF to finish. This does not terminate the process directly.',
    inputSchema: z.object({ id: z.string().uuid() }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ id }) => result(await audited(
    ctx.audit,
    'process_close_stdin',
    undefined,
    async () => ctx.processes.closeStdin(id)
  )));
}
