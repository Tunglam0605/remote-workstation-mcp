import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AppContext } from '../../context.js';
import { audited } from '../../security/audit.js';

const result = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  structuredContent: value as Record<string, unknown>
});

export function registerEngineeringNetworkTools(server: McpServer, ctx: AppContext): void {
  const networkHost = z.string().min(1).max(253);

  server.registerTool('network_provider_status', {
    description: 'Inspect cross-platform typed network-diagnostics provider availability. Read-only only; network configuration, route/firewall mutation and packet injection are unavailable.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async () => result(await audited(ctx.audit, 'network_provider_status', undefined, () => ctx.engineering.network.providerStatus())));

  server.registerTool('network_interface_list', {
    description: 'List bounded local network interface/address metadata using the host networking API. This is read-only and does not change interface state.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async () => result(await audited(ctx.audit, 'network_interface_list', undefined, () => ctx.engineering.network.interfaceList())));

  server.registerTool('network_route_list', {
    description: 'List the host routing table through a fixed machine-readable platform command. No route mutation or arbitrary command input is exposed.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async () => result(await audited(ctx.audit, 'network_route_list', undefined, () => ctx.engineering.network.routeList())));

  server.registerTool('network_dns_lookup', {
    description: 'Resolve one bounded hostname using the host DNS resolver and return IPv4/IPv6 addresses. URLs, raw resolver commands and DNS configuration changes are not accepted.',
    inputSchema: z.object({ host: networkHost, family: z.union([z.literal(0), z.literal(4), z.literal(6)]).default(0) }),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true }
  }, async ({ host, family }) => result(await audited(ctx.audit, 'network_dns_lookup', undefined, () => ctx.engineering.network.dnsLookup(host, family))));

  server.registerTool('network_ping', {
    description: 'Run a bounded ICMP reachability probe to one validated hostname/IP. Count and timeout are bounded; no raw ping arguments are accepted.',
    inputSchema: z.object({
      host: networkHost,
      count: z.number().int().min(1).max(20).default(4),
      timeoutMs: z.number().int().min(100).max(30_000).default(2_000)
    }),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true }
  }, async ({ host, count, timeoutMs }) => result(await audited(ctx.audit, 'network_ping', undefined, () => ctx.engineering.network.ping(host, { count, timeoutMs }))));

  server.registerTool('network_tcp_reachability', {
    description: 'Test a bounded TCP connect to one validated hostname/IP and explicit port. It opens no listener, sends no application payload, and returns only connection reachability evidence.',
    inputSchema: z.object({
      host: networkHost,
      port: z.number().int().min(1).max(65535),
      timeoutMs: z.number().int().min(50).max(30_000).default(2_000)
    }),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true }
  }, async ({ host, port, timeoutMs }) => result(await audited(ctx.audit, 'network_tcp_reachability', undefined, () => ctx.engineering.network.tcpReachability(host, port, { timeoutMs }))));
}
