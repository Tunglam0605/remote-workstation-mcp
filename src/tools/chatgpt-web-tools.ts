import os from 'node:os';
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AppContext } from '../context.js';
import { SERVER_VERSION } from '../capabilities.js';
import { audited } from '../security/audit.js';
import { currentPrincipal } from '../security/request-principal.js';

const result = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  structuredContent: value as Record<string, unknown>
});

function allows(scopes: readonly string[], required: string): boolean {
  return scopes.includes('*') || scopes.includes(required) || scopes.includes('workstation.full_control');
}

export function buildChatGptWebStatus(ctx: AppContext): Record<string, unknown> {
  const principal = currentPrincipal();
  const scopes = principal?.scopes ?? [];
  const authenticated = Boolean(principal?.authenticated);
  const openAiTunnelPrincipal = Boolean(
    principal && (
      principal.type === 'openai-secure-mcp-tunnel' ||
      principal.id === 'openai-tunnel' ||
      principal.type.toLowerCase().includes('openai')
    )
  );

  return {
    ok: true,
    server: 'remote-workstation-mcp',
    serverVersion: SERVER_VERSION,
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
        fullControl: authenticated && allows(scopes, 'workstation.full_control')
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
    verification: {
      message: authenticated && openAiTunnelPrincipal
        ? 'Authenticated ChatGPT/OpenAI tunnel request reached this workstation MCP runtime.'
        : 'This call did not arrive with the default authenticated OpenAI Secure MCP Tunnel principal.',
      nextSafeCheck: 'Call workspace_list, then git_status or fs_read in an authorized workspace before attempting writes.'
    }
  };
}

export function registerChatGptWebTools(server: McpServer, ctx: AppContext): void {
  server.registerTool('chatgpt_web_status', {
    description: 'Verify that ChatGPT Web reached this workstation through the authenticated MCP control path. Returns non-secret host identity, authenticated principal/scopes, effective permissions, policy mode and authorized workspace names. Use this as the first end-to-end verification tool after adding the custom app in ChatGPT Web.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async () => result(await audited(ctx.audit, 'chatgpt_web_status', undefined, async () => buildChatGptWebStatus(ctx))));
}
