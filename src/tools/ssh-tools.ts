import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AppContext } from '../context.js';
import { audited } from '../security/audit.js';

const result = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  structuredContent: value as Record<string, unknown>
});

export function registerSshTools(server: McpServer, ctx: AppContext): void {
  server.registerTool('ssh_hosts', {
    description: 'List remote SSH hosts explicitly authorized by the local owner configuration. Credentials and private-key paths are never returned.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async () => result({ hosts: await audited(ctx.audit, 'ssh_hosts', undefined, async () => ctx.ssh.listHosts()) }));

  server.registerTool('ssh_probe', {
    description: 'Test non-interactive SSH connectivity to an owner-approved named host without executing a workload.',
    inputSchema: z.object({ host: z.string().min(1) }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true }
  }, async ({ host }) => result(await audited(ctx.audit, 'ssh_probe', undefined, () => ctx.ssh.probe(host))));

  server.registerTool('ssh_exec', {
    description: 'Execute one program on an owner-approved SSH host. The host has its own program allowlist and optional remoteRoot; no password or private key is exposed to the model.',
    inputSchema: z.object({
      host: z.string().min(1),
      program: z.string().min(1),
      args: z.array(z.string()).max(200).default([]),
      cwd: z.string().default('.'),
      timeoutMs: z.number().int().positive().max(60 * 60 * 1000).optional()
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  }, async ({ host, program, args, cwd, timeoutMs }) => result(await audited(ctx.audit, 'ssh_exec', undefined, () => ctx.ssh.execute(host, program, args, cwd, timeoutMs))));
}
