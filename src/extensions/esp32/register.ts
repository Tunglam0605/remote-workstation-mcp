import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AppContext } from '../../context.js';
import { audited } from '../../security/audit.js';
import { serialDeviceSelectorSchema, workspacePathSchema } from '../../engineering/mcp-schemas.js';

const result = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  structuredContent: value as Record<string, unknown>
});

export function registerEsp32Tools(server: McpServer, ctx: AppContext): void {
  server.registerTool('esp32_preflight', {
    description: 'Preflight one ESP32/ESP-IDF project on the current host. Project profile defaults are honored for ESP-IDF root, build directory and stable serial identity; explicit arguments only override those defaults. No flash or target mutation is performed.',
    inputSchema: workspacePathSchema.extend({
      buildDir: z.string().min(1).max(512).optional(),
      espIdfPath: z.string().min(1).max(1024).optional(),
      port: z.string().min(1).max(512).optional(),
      portSelector: serialDeviceSelectorSchema.optional()
    }),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ workspace, projectPath, buildDir, espIdfPath, port, portSelector }) =>
    result(await audited(ctx.audit, 'esp32_preflight', workspace, () => ctx.engineering.workflows.esp32Preflight(
      workspace, projectPath, { buildDir, espIdfPath, port, portSelector }
    ))));
}
