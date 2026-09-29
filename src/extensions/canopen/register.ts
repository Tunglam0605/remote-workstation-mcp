import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AppContext } from '../../context.js';
import { audited } from '../../security/audit.js';
import { CanopenAdapter } from './canopen-adapter.js';

const result = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  structuredContent: value as Record<string, unknown>
});

const interfaceName = z.string().min(1).max(15).regex(/^[A-Za-z0-9_.:-]+$/);
const nodeId = z.number().int().min(1).max(127);

export function registerCanopenTools(server: McpServer, ctx: AppContext): void {
  const adapter = new CanopenAdapter(ctx.engineering.can);

  server.registerTool('canopen_provider_status', {
    description: 'Inspect passive CANopen/CiA 301 diagnostic readiness over the existing read-only SocketCAN provider. No CAN frame is transmitted.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async () => result(await audited(ctx.audit, 'canopen_provider_status', undefined, () => adapter.providerStatus())));

  server.registerTool('canopen_capture_decode', {
    description: 'Capture a bounded passive SocketCAN sample and decode standard 11-bit CANopen NMT, SYNC, EMCY, PDO, SDO and Heartbeat traffic. This never transmits, replays or configures CAN frames.',
    inputSchema: z.object({
      interface: interfaceName,
      count: z.number().int().min(1).max(1000).default(250),
      inactivityTimeoutMs: z.number().int().min(100).max(30_000).default(3_000),
      nodeIds: z.array(nodeId).max(32).default([])
    }),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ interface: selected, count, inactivityTimeoutMs, nodeIds }) => result(
    await audited(ctx.audit, 'canopen_capture_decode', undefined, () => adapter.captureDecode(selected, { count, inactivityTimeoutMs, nodeIds }))
  ));

  server.registerTool('canopen_node_observe', {
    description: 'Passively observe explicit or traffic-discovered CANopen node IDs and summarize Heartbeat/NMT state, boot-up, EMCY, SDO and PDO evidence from one bounded capture. An empty nodeIds list discovers only nodes already visible in captured traffic and never scans or transmits on the bus.',
    inputSchema: z.object({
      interface: interfaceName,
      count: z.number().int().min(1).max(1000).default(250),
      inactivityTimeoutMs: z.number().int().min(100).max(30_000).default(3_000),
      nodeIds: z.array(nodeId).max(32).default([])
    }),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ interface: selected, count, inactivityTimeoutMs, nodeIds }) => result(
    await audited(ctx.audit, 'canopen_node_observe', undefined, () => adapter.observeNodes(selected, { count, inactivityTimeoutMs, nodeIds }))
  ));
}
