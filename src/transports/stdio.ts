import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { SERVER_VERSION } from '../capabilities.js';
import type { McpServerFactory, TransportDescriptor, TransportProvider } from './types.js';

export class StdioTransportProvider implements TransportProvider {
  readonly descriptor: TransportDescriptor = {
    id: 'stdio-local',
    protocol: 'stdio',
    exposure: 'local-process',
    authentication: 'process-boundary'
  };

  async start(factory: McpServerFactory): Promise<void> {
    console.error(`[remote-workstation-mcp ${SERVER_VERSION}] starting stdio transport`);
    await serveStdio(factory);
  }
}
