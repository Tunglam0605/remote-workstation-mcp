#!/usr/bin/env node
import { SERVER_VERSION } from './capabilities.js';
import { createContext } from './context.js';
import { buildServer } from './server.js';
import { LoopbackHttpTransportProvider } from './transports/http.js';
import { StdioTransportProvider } from './transports/stdio.js';
import type { TransportProvider } from './transports/types.js';

if (process.argv.includes('--tui')) {
  await import('./tui-cli.js');
  process.exit(0);
}

if (process.argv.includes('--version') || process.argv.includes('-v')) {
  console.log(SERVER_VERSION);
  process.exit(0);
}

const context = await createContext();
const factory = () => buildServer(context);
const transport: TransportProvider = process.argv.includes('--stdio')
  ? new StdioTransportProvider()
  : new LoopbackHttpTransportProvider(context);

await transport.start(factory);
