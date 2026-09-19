import os from 'node:os';
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AppContext } from '../context.js';
import { ACTION_SCHEMA_VERSION, ENGINEERING_API_VERSION, SERVER_VERSION } from '../capabilities.js';
import { recommendedChatGptAppName } from '../device-identity.js';
import { audited } from '../security/audit.js';
import { currentPrincipal, principalHasExactScope } from '../security/request-principal.js';

const result = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  structuredContent: value as Record<string, unknown>
});

function allows(scopes: readonly string[], required: string): boolean {
  return scopes.includes('*') || scopes.includes(required) || scopes.includes('workstation.full_control');
}

export function buildChatGptWebStatus(ctx: AppContext): Record<string, unknown> {
  const principal = currentPrincipal();
  const identity = ctx.identity ?? {
    version: 1 as const,
    id: process.env.RWMCP_DEVICE_ID?.trim() || os.hostname().toLowerCase().replace(/[^a-z0-9._-]+/g, '-'),
    name: process.env.RWMCP_DEVICE_NAME?.trim() || os.hostname(),
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    createdAt: ''
  };
  const scopes = principal?.scopes ?? [];
  const authenticated = Boolean(principal?.authenticated);
  const openAiTunnelPrincipal = Boolean(
    principal && (
      principal.type === 'openai-secure-mcp-tunnel' ||
      principal.id === 'openai-tunnel' ||
      principal.type.toLowerCase().includes('openai')
    )
  );
  const dataPlane = ctx.dataPlane.status();
  const controlPlaneRelay = ctx.controlPlaneRelay.status();
  const multiNodeSecurity = ctx.multiNodeAuthorization.status();
  const multiNodePolicy = ctx.config.multiNode;
  const controllerPrincipalMatches = Boolean(
    principal &&
    multiNodePolicy?.enabled &&
    principal.id === multiNodePolicy.controllerPrincipalId &&
    principal.type === multiNodePolicy.controllerPrincipalType
  );
  const managedProcesses = ctx.processes.list();
  const terminalSessions = ctx.engineering.terminals.list();
  const hardwareLeases = ctx.engineering.resources.list();
  const healthWarnings = [
    ...(!dataPlane.directIpv4Available && !controlPlaneRelay.supported ? ['data-plane-unavailable'] : []),
    ...(authenticated && !openAiTunnelPrincipal ? ['unexpected-authenticated-principal'] : []),
    ...(ctx.policy.legacyRemoteControlEnabled() ? ['legacy-remote-control-enabled'] : [])
  ];

  return {
    ok: true,
    server: 'remote-workstation-mcp',
    serverVersion: SERVER_VERSION,
    actionSchemaVersion: ACTION_SCHEMA_VERSION,
    engineeringApiVersion: ENGINEERING_API_VERSION,
    device: {
      ...identity,
      recommendedAppName: recommendedChatGptAppName(identity),
      controlMode: 'direct-node'
    },
    host: {
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch()
    },
    chatgptWeb: {
      authenticated,
      secureTunnelPrincipal: openAiTunnelPrincipal,
      directControlPathVerified: authenticated && openAiTunnelPrincipal,
      principal: principal ? {
        id: principal.id,
        type: principal.type,
        scopes: [...principal.scopes]
      } : null,
      permissions: {
        read: authenticated && allows(scopes, 'workstation.read'),
        write: authenticated && allows(scopes, 'workstation.write'),
        execute: authenticated && allows(scopes, 'workstation.execute'),
        adminRequest: authenticated && allows(scopes, 'workstation.admin_request'),
        fullControl: authenticated && allows(scopes, 'workstation.full_control'),
        crossNodeTransfer: authenticated && controllerPrincipalMatches && principalHasExactScope('workstation.cross_node_transfer')
      }
    },
    policy: {
      mode: ctx.policy.effectiveMode(),
      permission: ctx.policy.status()
    },
    workspaces: ctx.config.workspaces.map(workspace => ({
      id: workspace.id,
      name: workspace.name ?? workspace.id,
      readOnly: workspace.readOnly ?? false
    })),
    nodeHealth: {
      state: authenticated && openAiTunnelPrincipal ? (healthWarnings.length ? 'degraded' : 'healthy') : 'reachable',
      runtimeUptimeSeconds: Math.floor(process.uptime()),
      osUptimeSeconds: Math.floor(os.uptime()),
      memory: {
        totalBytes: os.totalmem(),
        freeBytes: os.freemem()
      },
      activeSessions: {
        processes: managedProcesses.filter(item => item.status === 'running').length,
        terminals: terminalSessions.filter(item => item.status === 'running').length,
        hardwareLeases: hardwareLeases.length
      },
      dataPlane: {
        ...dataPlane,
        controlPlaneRelay
      },
      security: {
        multiNode: multiNodeSecurity,
        legacyRemoteControlEnabled: ctx.policy.legacyRemoteControlEnabled()
      },
      warnings: healthWarnings
    },
    verification: {
      message: authenticated && openAiTunnelPrincipal
        ? 'Authenticated ChatGPT/OpenAI tunnel request reached this workstation MCP runtime.'
        : 'This call did not arrive with the default authenticated OpenAI Secure MCP Tunnel principal.',
      nextSafeCheck: 'Call workspace_list, then git_status or fs_read in an authorized workspace before attempting writes.'
    }
  };
}

export function registerChatGptWebTools(server: McpServer, ctx: AppContext): void {
  server.registerTool('workstation_identity', {
    description: 'Return this workstation stable device identity and recommended ChatGPT app name. Use it to disambiguate multiple directly connected Remote Workstation apps without relying on IP addresses.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async () => result(await audited(ctx.audit, 'workstation_identity', undefined, async () => ({
    ...ctx.identity,
    recommendedAppName: recommendedChatGptAppName(ctx.identity),
    controlMode: 'direct-node'
  }))));

  server.registerTool('chatgpt_web_status', {
    description: 'Verify that ChatGPT Web reached this workstation through the authenticated MCP control path. Returns non-secret identity, permissions, workspaces and nodeHealth including runtime/session/data-plane status. Use it for first-call verification and client-side multi-node health aggregation.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async () => result(await audited(ctx.audit, 'chatgpt_web_status', undefined, async () => buildChatGptWebStatus(ctx))));
}
