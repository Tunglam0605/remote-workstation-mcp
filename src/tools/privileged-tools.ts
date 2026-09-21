import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AppContext } from '../context.js';
import { createAdminRequest, readAdminRequest } from '../privileged/approval-store.js';
import { audited } from '../security/audit.js';
import { currentPrincipal } from '../security/request-principal.js';
import { linuxHostRebootCommand } from '../tui/admin-requests.js';

const result = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  structuredContent: value as Record<string, unknown>
});

export function registerPrivilegedTools(server: McpServer, ctx: AppContext): void {
  server.registerTool('admin_request', {
    description: 'Request one generic Administrator/UAC action. This never elevates or executes by itself. Generic privileged execution remains Windows-only; Linux host reboot uses node_reboot_request so the Ubuntu TUI can approve one allowlisted reboot without opening a generic root shell.',
    inputSchema: z.object({
      program: z.string().min(1).max(4096),
      args: z.array(z.string().max(4096)).max(100).default([]),
      cwd: z.string().min(1).max(4096).optional(),
      reason: z.string().min(1).max(1000)
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async ({ program, args, cwd, reason }) => result(await audited(ctx.audit, 'admin_request', undefined, async () => {
    const request = await createAdminRequest({ program, args, cwd, reason });
    await ctx.desktopNotifications.notify({
      title: 'RWMCP cần quyền Administrator',
      body: reason,
      kind: 'approval'
    }).catch(() => undefined);
    return {
      requestId: request.id,
      state: request.state,
      expiresAt: request.expiresAt,
      message: 'Waiting for local owner approval in Remote Workstation Control Center.'
    };
  })));

  server.registerTool('node_reboot_request', {
    description: 'Request one owner-approved Linux host reboot. The request is fixed to /usr/bin/systemctl --no-block reboot, never executes by itself, and must be reviewed in the Ubuntu TUI Admin requests screen. This is distinct from restarting only the RWMCP runtime.',
    inputSchema: z.object({ reason: z.string().min(1).max(1000) }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ reason }) => result(await audited(ctx.audit, 'node_reboot_request', undefined, async () => {
    if (process.platform !== 'linux') throw new Error('node_reboot_request currently supports Linux hosts only.');
    const command = linuxHostRebootCommand();
    const request = await createAdminRequest({ program: command.program, args: command.args, reason });
    return {
      requestId: request.id,
      state: request.state,
      expiresAt: request.expiresAt,
      command: [request.program, ...request.args],
      message: 'Waiting for local owner approval in the Ubuntu Remote Workstation TUI -> Admin requests. Restart runtime does not reboot the host.'
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
