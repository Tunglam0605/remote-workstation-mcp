export interface ConnectionDescriptor {
  id: string;
  transport: 'secure-mcp-tunnel';
  exposure: 'outbound-only';
  localEndpoint: string;
  authentication: 'bearer';
}

export interface ConnectionProvider {
  readonly descriptor: ConnectionDescriptor;
  start(): Promise<void>;
  stop(): Promise<void>;
}
