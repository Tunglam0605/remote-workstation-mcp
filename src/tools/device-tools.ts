import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AppContext } from '../context.js';
import { audited } from '../security/audit.js';

const result = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  structuredContent: value as Record<string, unknown>
});

export function registerDeviceTools(server: McpServer, ctx: AppContext): void {
  server.registerTool('device_list', {
    description: 'List the local Hub and owner-registered remote devices. By default this also probes registered remote devices and reports online state/latency. Credentials are never returned.',
    inputSchema: z.object({ probe: z.boolean().default(true) }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true }
  }, async ({ probe }) => result({ devices: await audited(ctx.audit, 'device_list', undefined, () => ctx.devices.list(probe)) }));

  server.registerTool('device_probe', {
    description: 'Check whether an owner-registered device is reachable from the Remote Workstation Hub.',
    inputSchema: z.object({ device: z.string().min(1) }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true }
  }, async ({ device }) => result(await audited(ctx.audit, 'device_probe', undefined, () => ctx.devices.probe(device))));

  server.registerTool('device_exec', {
    description: 'Execute one owner-allowlisted program on an owner-registered remote device through its configured secure transport. For the local workstation, use normal process/task tools.',
    inputSchema: z.object({ device: z.string().min(1), program: z.string().min(1), args: z.array(z.string()).max(200).default([]), cwd: z.string().default('.'), timeoutMs: z.number().int().positive().max(60 * 60 * 1000).optional() }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  }, async ({ device, program, args, cwd, timeoutMs }) => result(await audited(ctx.audit, 'device_exec', undefined, () => ctx.devices.execute(device, program, args, cwd, timeoutMs))));
}
