import type { McpServer } from '@modelcontextprotocol/server';

export type McpServerFactory = () => McpServer;

export interface TransportDescriptor {
  id: string;
  protocol: 'stdio' | 'streamable-http';
  exposure: 'local-process' | 'loopback' | 'remote';
  authentication: string;
  endpoint?: string;
}

export interface TransportProvider {
  readonly descriptor: TransportDescriptor;
  start(factory: McpServerFactory): Promise<void>;
}
