#!/usr/bin/env node
import { OpenAiSecureTunnelConnectionProvider } from './connections/openai-secure-tunnel.js';

// Managed Cloudflare runtime material is optional and is not provisioned for
// every logical tunnel. Keep the portable supervisor on the direct control-plane
// path by default; owners can explicitly opt in with CLOUDFLARED_MANAGED=true.
process.env.CLOUDFLARED_MANAGED ??= 'false';

const provider = new OpenAiSecureTunnelConnectionProvider();
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`[remote-workstation-mcp] ${signal}: stopping OpenAI Secure MCP Tunnel connection...`);
  await provider.stop();
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown(signal).finally(() => process.exit(0));
  });
}

try {
  await provider.start();
  await provider.wait();
} catch (error) {
  await provider.stop();
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
