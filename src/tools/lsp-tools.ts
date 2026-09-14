import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AppContext } from '../context.js';
import { audited } from '../security/audit.js';

const result = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  structuredContent: value as Record<string, unknown>
});

const positionSchema = {
  workspace: z.string().min(1),
  server: z.string().min(1),
  path: z.string().min(1),
  line: z.number().int().min(0),
  character: z.number().int().min(0)
};

export function registerLspTools(server: McpServer, ctx: AppContext): void {
  server.registerTool('lsp_servers', {
    description: 'List owner-configured language-server profiles and their file-extension to language-ID mappings.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async () => result({ servers: await audited(ctx.audit, 'lsp_servers', undefined, async () => ctx.lsp.listServers()) }));

  server.registerTool('lsp_definition', {
    description: 'Resolve a symbol definition semantically through an owner-approved language server. File locations outside the authorized workspace are redacted.',
    inputSchema: z.object(positionSchema),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ workspace, server: profile, path, line, character }) => result(await audited(
    ctx.audit,
    'lsp_definition',
    workspace,
    () => ctx.lsp.definition(workspace, profile, path, line, character)
  )));

  server.registerTool('lsp_references', {
    description: 'Find semantic references to a symbol through an owner-approved language server. File locations outside the authorized workspace are redacted.',
    inputSchema: z.object({ ...positionSchema, includeDeclaration: z.boolean().default(true) }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ workspace, server: profile, path, line, character, includeDeclaration }) => result(await audited(
    ctx.audit,
    'lsp_references',
    workspace,
    () => ctx.lsp.references(workspace, profile, path, line, character, includeDeclaration)
  )));

  server.registerTool('lsp_hover', {
    description: 'Return bounded type/signature/documentation hover information for a source position.',
    inputSchema: z.object(positionSchema),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ workspace, server: profile, path, line, character }) => result({ hover: await audited(
    ctx.audit,
    'lsp_hover',
    workspace,
    () => ctx.lsp.hover(workspace, profile, path, line, character)
  ) }));

  server.registerTool('lsp_document_symbols', {
    description: 'Return semantic symbols for one source document without requiring a full-text grep.',
    inputSchema: z.object({ workspace: z.string().min(1), server: z.string().min(1), path: z.string().min(1) }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ workspace, server: profile, path }) => result({ symbols: await audited(
    ctx.audit,
    'lsp_document_symbols',
    workspace,
    () => ctx.lsp.documentSymbols(workspace, profile, path)
  ) }));

  server.registerTool('lsp_diagnostics', {
    description: 'Return the latest bounded publishDiagnostics notification for a document after it is opened/synchronized with the language server.',
    inputSchema: z.object({ workspace: z.string().min(1), server: z.string().min(1), path: z.string().min(1) }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ workspace, server: profile, path }) => result(await audited(
    ctx.audit,
    'lsp_diagnostics',
    workspace,
    () => ctx.lsp.diagnostics(workspace, profile, path)
  )));
}
