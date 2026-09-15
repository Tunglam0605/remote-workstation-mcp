#!/usr/bin/env node
import { startSetupServer } from './setup/setup-server.js';

const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);
const value = (name: string): string | undefined => {
  const index = rawArgs.indexOf(name);
  return index >= 0 ? rawArgs[index + 1] : undefined;
};
const openBrowser = !args.has('--no-open');
const requestedPort = value('--port');
const port = requestedPort === undefined ? undefined : Number(requestedPort);
const server = await startSetupServer({
  openBrowser,
  port,
  strictPort: args.has('--strict-port') || args.has('--persistent')
});

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

console.error(args.has('--persistent')
  ? '[remote-workstation-mcp] Persistent local Control Center is running.'
  : '[remote-workstation-mcp] Press Ctrl+C when setup is complete.');
