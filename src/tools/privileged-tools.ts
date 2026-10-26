import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AppContext } from '../context.js';
import { createAdminRequest, readAdminRequest } from '../privileged/approval-store.js';
import { normalizeWindowsSudoRequest } from '../privileged/windows-sudo-compat.js';
import { audited } from '../security/audit.js';
import { currentPrincipal } from '../security/request-principal.js';
import { isLinuxAptInstallCommand, linuxHostRebootCommand } from '../tui/admin-requests.js';

const result = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  structuredContent: value as Record<string, unknown>
});

export function registerPrivilegedTools(server: McpServer, ctx: AppContext): void {
  server.registerTool('admin_request', {
    description: 'Request one owner-approved privileged action. On Windows 11, program=sudo or sudo.exe with args=[direct .exe, ...argv] is normalized to the direct executable and held for local Control Center approval then RunAs/UAC; native Windows sudo.exe need not be enabled. No sudo flags, command shell, self-approval, or silent elevation. Linux remains limited to typed apt-get install -y here; use node_reboot_request for host reboot. The request never executes by itself.',
    inputSchema: z.object({
      program: z.string().min(1).max(4096),
      args: z.array(z.string().max(4096)).max(100).default([]),
      cwd: z.string().min(1).max(4096).optional(),
      reason: z.string().min(1).max(1000)
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async ({ program, args, cwd, reason }) => result(await audited(ctx.audit, 'admin_request', undefined, async () => {
    if (process.platform === 'linux' && !isLinuxAptInstallCommand({ program, args, cwd })) {
      throw new Error('Linux admin_request accepts only typed apt-get install -y package requests. Use node_reboot_request for host reboot.');
    }
    if (process.platform !== 'linux' && process.platform !== 'win32') {
      throw new Error('admin_request is unavailable on this platform.');
    }
    const command = normalizeWindowsSudoRequest({ program, args, cwd }, process.platform);
    const request = await createAdminRequest({
      program: command.program,
      args: command.args,
      cwd: command.cwd,
      reason
    });
    await ctx.desktopNotifications.notify({
      title: 'RWMCP cần quyền Administrator',
      body: reason,
      kind: 'approval'
    }).catch(() => undefined);
    return {
      requestId: request.id,
      state: request.state,
      expiresAt: request.expiresAt,
      sudoCompatibility: command.sudoCompatibility,
      elevation: command.sudoCompatibility ? 'owner-approved-runas-uac' : 'platform-default',
      message: command.sudoCompatibility
        ? 'Windows sudo-compatible request normalized to a direct executable. Waiting for separate owner approval in Remote Workstation Control Center and Windows UAC; this did not run or bypass approval.'
        : 'Waiting for local owner approval in Remote Workstation Control Center.'
    };
  })));

  server.registerTool('node_reboot_request', {
    description: 'Request one owner-approved Linux host reboot. The request is fixed to /usr/bin/systemctl --no-block reboot, never executes by itself, and must be reviewed in an owner-local Ubuntu approval surface (Control Center or TUI). This is distinct from restarting only the RWMCP runtime.',
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
      message: 'Waiting for local owner approval in Ubuntu Remote Workstation Control Center or TUI -> Admin requests. Restart runtime does not reboot the host.'
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
