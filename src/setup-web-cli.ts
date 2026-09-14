#!/usr/bin/env node
import { startSetupServer } from './setup/setup-server.js';

const args = new Set(process.argv.slice(2));
const openBrowser = !args.has('--no-open');
const server = await startSetupServer({ openBrowser });

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  console.error(`[remote-workstation-mcp] ${signal}: stopping Setup Console...`);
  await server.close();
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown(signal).finally(() => process.exit(0));
  });
}

console.error('[remote-workstation-mcp] Press Ctrl+C when setup is complete.');
