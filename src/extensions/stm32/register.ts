import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AppContext } from '../../context.js';
import { audited } from '../../security/audit.js';
import { workspacePathSchema } from '../../engineering/mcp-schemas.js';

const result = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  structuredContent: value as Record<string, unknown>
});

export function registerStm32Tools(server: McpServer, ctx: AppContext): void {
  server.registerTool('stm32_ioc_inspect', {
    description: 'Read a bounded STM32 CubeMX .ioc file and return typed MCU/package, project/toolchain, clock-frequency, pin/signal/label and peripheral-parameter metadata without running CubeMX or project code.',
    inputSchema: workspacePathSchema.extend({ iocFile: z.string().min(1).max(255).regex(/^[^\\/]+\.ioc$/i).optional() }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ workspace, projectPath, iocFile }) => result(await audited(ctx.audit, 'stm32_ioc_inspect', workspace, () => ctx.engineering.stm32Ioc.inspect(workspace, projectPath, iocFile))));

  server.registerTool('stm32_svd_inspect', {
    description: 'Inspect a project-scoped CMSIS-SVD file and return bounded STM32 device, peripheral, register, cluster and bit-field metadata without connecting to target hardware or allowing register writes.',
    inputSchema: workspacePathSchema.extend({ svdFile: z.string().min(1).max(1024) }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ workspace, projectPath, svdFile }) => result(await audited(ctx.audit, 'stm32_svd_inspect', workspace, () => ctx.engineering.stm32Svd.inspect(workspace, projectPath, svdFile))));
}
