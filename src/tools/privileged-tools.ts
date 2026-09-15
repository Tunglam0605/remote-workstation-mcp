import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AppContext } from '../context.js';
import { createAdminRequest, readAdminRequest } from '../privileged/approval-store.js';
import { audited } from '../security/audit.js';
import { currentPrincipal } from '../security/request-principal.js';

const result = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  structuredContent: value as Record<string, unknown>
});

export function registerPrivilegedTools(server: McpServer, ctx: AppContext): void {
  server.registerTool('admin_request', {
    description: 'Request one Administrator/UAC action. This never elevates or executes by itself: the local owner must review the exact program/arguments and approve once in Control Center before Windows RunAs/UAC elevation is attempted.',
    inputSchema: z.object({
      program: z.string().min(1).max(4096),
      args: z.array(z.string().max(4096)).max(100).default([]),
      cwd: z.string().min(1).max(4096).optional(),
      reason: z.string().min(1).max(1000)
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async ({ program, args, cwd, reason }) => result(await audited(ctx.audit, 'admin_request', undefined, async () => {
    const request = await createAdminRequest({ program, args, cwd, reason });
    return {
      requestId: request.id,
      state: request.state,
      expiresAt: request.expiresAt,
      message: 'Waiting for local owner approval in Remote Workstation Control Center.'
    };
  })));

  server.registerTool('admin_request_status', {
    description: 'Check the state/result of one previously created Administrator approval request.',
    inputSchema: z.object({ requestId: z.string().uuid() }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ requestId }) => result(await audited(ctx.audit, 'admin_request_status', undefined, async () => {
    const request = await readAdminRequest(requestId);
    const principal = currentPrincipal();
    if (principal && request.clientId !== principal.id) {
      throw new Error('Administrator request belongs to a different authenticated client.');
    }
    return {
      requestId: request.id,
      state: request.state,
      createdAt: request.createdAt,
      expiresAt: request.expiresAt,
      approvedAt: request.approvedAt,
      deniedAt: request.deniedAt,
      startedAt: request.startedAt,
      result: request.result
    };
  })));
}
