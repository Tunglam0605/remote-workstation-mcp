import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AppContext } from '../../context.js';
import { audited } from '../../security/audit.js';
import { ModbusTcpAdapter } from './modbus-tcp-adapter.js';

const result = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  structuredContent: value as Record<string, unknown>
});

const host = z.string().min(1).max(253);
const port = z.number().int().min(1).max(65_535).default(502);
const unitId = z.number().int().min(0).max(255);
const fn = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
const address = z.number().int().min(0).max(65_535);
const quantity = z.number().int().min(1).max(2000);

export function registerModbusTcpTools(server: McpServer, ctx: AppContext): void {
  const adapter = new ModbusTcpAdapter(ctx.policy);

  server.registerTool('modbus_tcp_provider_status', {
    description: 'Inspect cross-platform Modbus TCP read-only provider capabilities. Phase 1 exposes only functions 01/02/03/04 and no write or raw-PDU surface.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async () => result(await audited(ctx.audit, 'modbus_tcp_provider_status', undefined, () => adapter.providerStatus())));

  server.registerTool('modbus_tcp_endpoint_status', {
    description: 'Check bounded TCP reachability for one explicit Modbus TCP endpoint. No Modbus request is sent.',
    inputSchema: z.object({
      host,
      port,
      timeoutMs: z.number().int().min(50).max(10_000).default(1_000)
    }).strict(),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true }
  }, async ({ host: selected, port: selectedPort, timeoutMs }) => result(
    await audited(ctx.audit, 'modbus_tcp_endpoint_status', undefined, () => adapter.endpointStatus(selected, { port: selectedPort, timeoutMs }))
  ));

  server.registerTool('modbus_tcp_read', {
    description: 'Perform one bounded read-only Modbus TCP request using function 01, 02, 03 or 04 against an explicit host/port/unit ID. MBAP transaction, protocol, length, unit and response byte counts are validated.',
    inputSchema: z.object({
      host,
      port,
      unitId,
      function: fn,
      address,
      quantity,
      timeoutMs: z.number().int().min(50).max(10_000).default(1_000)
    }).strict(),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true }
  }, async ({ host: selected, port: selectedPort, unitId: selectedUnit, function: selectedFn, address: start, quantity: count, timeoutMs }) => result(
    await audited(ctx.audit, 'modbus_tcp_read', undefined, () =>
      adapter.read(selected, selectedUnit, selectedFn, start, count, { port: selectedPort, timeoutMs })
    )
  ));

  server.registerTool('modbus_tcp_probe', {
    description: 'Probe 1..32 explicit Modbus TCP Unit Identifiers with one bounded read request per ID. This never scans a subnet or implicit 0..255 unit range and never writes.',
    inputSchema: z.object({
      host,
      port,
      unitIds: z.array(unitId).min(1).max(32),
      function: fn.default(3),
      address: address.default(0),
      timeoutMs: z.number().int().min(50).max(3_000).default(500)
    }).strict(),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true }
  }, async ({ host: selected, port: selectedPort, unitIds, function: selectedFn, address: start, timeoutMs }) => result(
    await audited(ctx.audit, 'modbus_tcp_probe', undefined, () =>
      adapter.probe(selected, unitIds, { port: selectedPort, function: selectedFn, address: start, timeoutMs })
    )
  ));
}
