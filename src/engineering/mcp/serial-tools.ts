import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AppContext } from '../../context.js';
import { audited } from '../../security/audit.js';

const result = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  structuredContent: value as Record<string, unknown>
});

export function registerEngineeringSerialTools(server: McpServer, ctx: AppContext): void {
  server.registerTool('serial_open', {
    description: 'Open a bounded caller-owned serial monitor session. Opening is non-destructive but unavailable in Read Only mode.',
    inputSchema: z.object({ port: z.string().min(1), baudRate: z.number().int().min(300).max(12_000_000), workSessionId: z.string().uuid().optional() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async ({ port, baudRate, workSessionId }) => result(await audited(ctx.audit, 'serial_open', undefined, () => ctx.runInWorkSession(workSessionId, () => ctx.engineering.serial.open(port, baudRate)))));

  server.registerTool('serial_read', {
    description: 'Read incremental UTF-8 output from a caller-owned serial session using a byte cursor.',
    inputSchema: z.object({ id: z.string().uuid(), cursor: z.number().int().nonnegative().default(0), workSessionId: z.string().uuid().optional() }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ id, cursor, workSessionId }) => result(await audited(ctx.audit, 'serial_read', undefined, () => ctx.runInWorkSession(workSessionId, () => ctx.engineering.serial.read(id, cursor)))));

  server.registerTool('serial_wait_for_text', {
    description: 'Wait for a bounded UTF-8 marker in a caller-owned serial session. Useful for boot/readiness acceptance without repeated polling from ChatGPT.',
    inputSchema: z.object({
      id: z.string().uuid(),
      expectedText: z.string().min(1).max(512),
      timeoutMs: z.number().int().min(100).max(120_000).default(10_000),
      cursor: z.number().int().nonnegative().default(0),
      workSessionId: z.string().uuid().optional()
    }),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ id, expectedText, timeoutMs, cursor, workSessionId }) => result(
    await audited(ctx.audit, 'serial_wait_for_text', undefined, () =>
      ctx.runInWorkSession(workSessionId, () => ctx.engineering.serial.waitForText(id, expectedText, timeoutMs, cursor))
    )
  ));

  server.registerTool('serial_write', {
    description: 'Write bounded data to a caller-owned serial session. Requires hardware-mutation permission unless the owner explicitly relaxes serial-write policy.',
    inputSchema: z.object({ id: z.string().uuid(), data: z.string(), encoding: z.enum(['utf8', 'hex', 'base64']).default('utf8'), workSessionId: z.string().uuid().optional() }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ id, data, encoding, workSessionId }) => result(await audited(ctx.audit, 'serial_write', undefined, () => ctx.runInWorkSession(workSessionId, () => ctx.engineering.serial.write(id, data, encoding)))));

  server.registerTool('serial_close', {
    description: 'Close a caller-owned serial session and release its hardware resource lease.',
    inputSchema: z.object({ id: z.string().uuid(), workSessionId: z.string().uuid().optional() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ id, workSessionId }) => result(await audited(ctx.audit, 'serial_close', undefined, () => ctx.runInWorkSession(workSessionId, () => ctx.engineering.serial.close(id)))));
}
