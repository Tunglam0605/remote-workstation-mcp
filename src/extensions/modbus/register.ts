import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AppContext } from '../../context.js';
import { audited } from '../../security/audit.js';

const result = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  structuredContent: value as Record<string, unknown>
});

export function registerModbusTools(server: McpServer, ctx: AppContext): void {
  const modbusSerialOptions = {
    baudRate: z.number().int().min(300).max(12_000_000).default(9600),
    dataBits: z.union([z.literal(7), z.literal(8)]).default(8),
    parity: z.enum(['none', 'even', 'odd']).default('even'),
    stopBits: z.union([z.literal(1), z.literal(2)]).default(1),
    timeoutMs: z.number().int().min(50).max(30_000).default(1000)
  };
  const modbusReadFunction = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);

  server.registerTool('modbus_rtu_provider_status', {
    description: 'Inspect bounded Modbus RTU provider availability. Phase 1 exposes read-only Modbus functions 01/02/03/04 only; write functions and raw frame injection are unavailable.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async () => result(await audited(ctx.audit, 'modbus_rtu_provider_status', undefined, () => ctx.engineering.modbusRtu.providerStatus())));

  server.registerTool('modbus_rtu_endpoint_status', {
    description: 'Inspect one explicit serial endpoint for Modbus RTU use without opening a protocol session or modifying the device.',
    inputSchema: z.object({ port: z.string().min(1).max(512) }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ port }) => result(await audited(ctx.audit, 'modbus_rtu_endpoint_status', undefined, () => ctx.engineering.modbusRtu.endpointStatus(port))));

  server.registerTool('modbus_rtu_read', {
    description: 'Perform one bounded Modbus RTU read request on an explicit serial port and Unit ID using only function 01, 02, 03 or 04. Validates CRC, response identity, exception frames and protocol quantity limits. No Modbus write function is exposed.',
    inputSchema: z.object({
      port: z.string().min(1).max(512),
      unitId: z.number().int().min(1).max(247),
      function: modbusReadFunction,
      address: z.number().int().min(0).max(65535),
      quantity: z.number().int().min(1).max(2000),
      ...modbusSerialOptions
    }),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ port, unitId, function: fn, address, quantity, baudRate, dataBits, parity, stopBits, timeoutMs }) =>
    result(await audited(ctx.audit, 'modbus_rtu_read', undefined, () => ctx.engineering.modbusRtu.read(
      port, unitId, fn, address, quantity, { baudRate, dataBits, parity, stopBits, timeoutMs }
    ))));

  server.registerTool('modbus_rtu_probe', {
    description: 'Probe 1-32 explicit Modbus RTU Unit IDs using one bounded read-only function (01/02/03/04) and one address. The tool does not scan unspecified IDs and never writes device state.',
    inputSchema: z.object({
      port: z.string().min(1).max(512),
      unitIds: z.array(z.number().int().min(1).max(247)).min(1).max(32),
      function: modbusReadFunction.default(3),
      address: z.number().int().min(0).max(65535).default(0),
      ...modbusSerialOptions
    }),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ port, unitIds, function: fn, address, baudRate, dataBits, parity, stopBits, timeoutMs }) =>
    result(await audited(ctx.audit, 'modbus_rtu_probe', undefined, () => ctx.engineering.modbusRtu.probe(
      port, unitIds, { function: fn, address, baudRate, dataBits, parity, stopBits, timeoutMs }
    ))));
}
