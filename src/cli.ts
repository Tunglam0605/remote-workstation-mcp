#!/usr/bin/env node
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createContext } from './context.js';
import { buildServer } from './server.js';

const context = await createContext();
const factory = () => buildServer(context);
const useStdio = process.argv.includes('--stdio');

if (useStdio) {
  console.error('[remote-workstation-mcp] starting stdio transport');
  await serveStdio(factory);
} else {
  const port = Number(process.env.RWMCP_PORT ?? 8765);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('RWMCP_PORT must be a valid TCP port.');
  const app = createMcpExpressApp();
  const nodeHandler = toNodeHandler(createMcpHandler(factory));
  app.get('/', (_req, res) => res.json({ name: 'remote-workstation-mcp', version: '0.1.0', mcp: '/mcp', health: '/healthz' }));
  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.all('/mcp', (req, res) => void nodeHandler(req, res, req.body));
  app.listen(port, '127.0.0.1', () => console.error(`[remote-workstation-mcp] http://127.0.0.1:${port}/mcp`));
}
