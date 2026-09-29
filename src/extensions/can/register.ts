import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AppContext } from '../../context.js';
import { audited } from '../../security/audit.js';

const result = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  structuredContent: value as Record<string, unknown>
});

export function registerCanTools(server: McpServer, ctx: AppContext): void {
  const canInterfaceName = z.string().min(1).max(15).regex(/^[A-Za-z0-9_.:-]+$/);
  const canFilter = z.object({
    id: z.number().int().min(0).max(0x1fffffff),
    mask: z.number().int().min(0).max(0x1fffffff),
    extended: z.boolean().default(false)
  }).strict();

  server.registerTool('can_provider_status', {
    description: 'Inspect bounded SocketCAN provider availability. This is read-only and never configures interfaces or transmits frames.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async () => result(await audited(ctx.audit, 'can_provider_status', undefined, () => ctx.engineering.can.providerStatus())));

  server.registerTool('can_interface_list', {
    description: 'List Linux SocketCAN CAN/vcan interfaces with bounded state, bit-timing, error-counter and packet statistics. No interface configuration is changed.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async () => result({ interfaces: await audited(ctx.audit, 'can_interface_list', undefined, () => ctx.engineering.can.listInterfaces()) }));

  server.registerTool('can_interface_status', {
    description: 'Inspect one explicit Linux SocketCAN CAN/vcan interface using machine-readable iproute2 netlink output.',
    inputSchema: z.object({ interface: canInterfaceName }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ interface: interfaceName }) => result(await audited(ctx.audit, 'can_interface_status', undefined, () => ctx.engineering.can.interfaceStatus(interfaceName))));

  server.registerTool('can_capture', {
    description: 'Capture a bounded read-only SocketCAN traffic sample from one explicit interface using candump. Supports up to 32 typed CAN-ID/mask filters, at most 1000 frames and a bounded inactivity timeout. Frame transmission, replay and interface mutation are not exposed.',
    inputSchema: z.object({
      interface: canInterfaceName,
      count: z.number().int().min(1).max(1000).default(100),
      inactivityTimeoutMs: z.number().int().min(100).max(30_000).default(2_000),
      filters: z.array(canFilter).max(32).default([]),
      includeErrorFrames: z.boolean().default(false)
    }),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ interface: interfaceName, count, inactivityTimeoutMs, filters, includeErrorFrames }) => result(
    await audited(ctx.audit, 'can_capture', undefined, () => ctx.engineering.can.capture(interfaceName, { count, inactivityTimeoutMs, filters, includeErrorFrames }))
  ));
}
