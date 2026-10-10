import type { McpServer } from '@modelcontextprotocol/server';

/**
 * Records the names actually passed to a particular server instance's MCP
 * registration API. It is deliberately not an authorization or exposure
 * override. A registered name is NOT proof of remote tools/list delivery.
 *
 * Install before registering any tools. Keep one ledger per server instance
 * (not per process, principal or context) to avoid cross-client contamination.
 */
export function trackRegisteredMcpTools(server: McpServer): () => readonly string[] {
  const names = new Set<string>();
  const original = server.registerTool;
  server.registerTool = ((...args: Parameters<McpServer['registerTool']>) => {
    const outcome = Reflect.apply(original, server, args) as ReturnType<McpServer['registerTool']>;
    names.add(args[0]);
    return outcome;
  }) as McpServer['registerTool'];
  return () => [...names].sort();
}
