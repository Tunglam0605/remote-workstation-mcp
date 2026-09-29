import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AppContext } from '../../context.js';
import { audited } from '../../security/audit.js';
import { OpcUaAdapter } from './opcua-adapter.js';

const result = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  structuredContent: value as Record<string, unknown>
});

const endpointUrl = z.string().min(1).max(1024);
const nodeId = z.string().min(1).max(512);
const timeoutMs = z.number().int().min(250).max(30_000).default(5_000);
const attribute = z.enum([
  'Value',
  'DisplayName',
  'BrowseName',
  'Description',
  'NodeClass',
  'DataType',
  'ValueRank',
  'AccessLevel',
  'UserAccessLevel'
]);

export function registerOpcUaTools(server: McpServer, ctx: AppContext): void {
  const adapter = new OpcUaAdapter(ctx.policy);

  server.registerTool('opcua_provider_status', {
    description: 'Inspect the OPC UA Phase 1 client provider. Phase 1 is anonymous, read-only, opc.tcp only, uses an in-memory certificate/key provider, and exposes only GetEndpoints, Browse and Read.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async () => result(await audited(ctx.audit, 'opcua_provider_status', undefined, () => adapter.providerStatus())));

  server.registerTool('opcua_endpoint_describe', {
    description: 'Connect to one explicit opc.tcp endpoint and return bounded endpoint/security/user-token metadata without returning server certificates. No session mutation or write service is invoked.',
    inputSchema: z.object({ endpointUrl, timeoutMs }).strict(),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true }
  }, async ({ endpointUrl: endpoint, timeoutMs: timeout }) => result(
    await audited(ctx.audit, 'opcua_endpoint_describe', undefined, () => adapter.endpointDescribe(endpoint, { timeoutMs: timeout }))
  ));

  server.registerTool('opcua_browse', {
    description: 'Open an anonymous SecurityPolicy.None OPC UA session to one explicit endpoint and perform a bounded forward Browse from one explicit NodeId. Continuation points are reported but not followed automatically.',
    inputSchema: z.object({
      endpointUrl,
      nodeId,
      maxReferences: z.number().int().min(1).max(256).default(64),
      timeoutMs
    }).strict(),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true }
  }, async ({ endpointUrl: endpoint, nodeId: selectedNode, maxReferences, timeoutMs: timeout }) => result(
    await audited(ctx.audit, 'opcua_browse', undefined, () =>
      adapter.browse(endpoint, selectedNode, { maxReferences, timeoutMs: timeout })
    )
  ));

  server.registerTool('opcua_read', {
    description: 'Open an anonymous SecurityPolicy.None OPC UA session to one explicit endpoint and read 1..32 explicit NodeId/attribute pairs. Values are recursively bounded before they are returned.',
    inputSchema: z.object({
      endpointUrl,
      items: z.array(z.object({
        nodeId,
        attribute: attribute.default('Value')
      }).strict()).min(1).max(32),
      timeoutMs
    }).strict(),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true }
  }, async ({ endpointUrl: endpoint, items, timeoutMs: timeout }) => result(
    await audited(ctx.audit, 'opcua_read', undefined, () => adapter.read(endpoint, items, { timeoutMs: timeout }))
  ));
}
