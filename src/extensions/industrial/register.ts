import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AppContext } from '../../context.js';
import { audited } from '../../security/audit.js';
import { IndustrialProfileAdapter } from './industrial-adapter.js';
import { IndustrialProfileStore } from './profile-store.js';

const result = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  structuredContent: value as Record<string, unknown>
});

const profileId = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);

export function registerIndustrialTools(server: McpServer, ctx: AppContext): void {
  const adapter = new IndustrialProfileAdapter(new IndustrialProfileStore(), ctx.policy);

  server.registerTool('industrial_profile_list', {
    description: 'List bounded owner-local non-secret industrial endpoint profiles for Modbus TCP, OPC UA and MQTT/AGV without opening network connections.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async () => result(await audited(ctx.audit, 'industrial_profile_list', undefined, () => adapter.list())));

  server.registerTool('industrial_profile_inspect', {
    description: 'Inspect one owner-local non-secret industrial endpoint profile. MQTT credentials remain in the separate MQTT profile store/environment and are never returned.',
    inputSchema: z.object({ profileId }).strict(),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ profileId: selected }) => result(
    await audited(ctx.audit, 'industrial_profile_inspect', undefined, () => adapter.inspect(selected))
  ));

  server.registerTool('industrial_profile_preflight', {
    description: 'Run one bounded read-only readiness preflight for an explicit industrial profile. Modbus checks TCP reachability, OPC UA checks endpoint metadata, and MQTT/AGV connects/subscribes without publishing or returning payload contents.',
    inputSchema: z.object({
      profileId,
      timeoutMs: z.number().int().min(250).max(10_000).default(2_000)
    }).strict(),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true }
  }, async ({ profileId: selected, timeoutMs }) => result(
    await audited(ctx.audit, 'industrial_profile_preflight', undefined, () => adapter.preflight(selected, timeoutMs))
  ));
}
