import assert from 'node:assert/strict';
import test from 'node:test';
import type { McpServer } from '@modelcontextprotocol/server';
import { trackRegisteredMcpTools } from '../src/mcp-registration-ledger.js';

function fakeServer() {
  const registered: string[] = [];
  const server = {
    registerTool(name: string) {
      if (name === 'reject') throw new Error('registration failed');
      registered.push(name);
      return { name };
    }
  };
  return { server: server as unknown as McpServer, registered };
}

test('records successful registration only and does not alter call arguments/result', () => {
  const { server, registered } = fakeServer();
  const snapshot = trackRegisteredMcpTools(server);
  const result = (server.registerTool as unknown as (name: string) => { name: string })('zeta');
  (server.registerTool as unknown as (name: string) => { name: string })('alpha');
  assert.deepEqual(result, { name: 'zeta' });
  assert.deepEqual(registered, ['zeta', 'alpha']);
  assert.deepEqual(snapshot(), ['alpha', 'zeta']);
});

test('rejecting registration must never appear as registered', () => {
  const { server } = fakeServer();
  const snapshot = trackRegisteredMcpTools(server);
  assert.throws(() => (server.registerTool as unknown as (name: string) => void)('reject'), /failed/);
  assert.deepEqual(snapshot(), []);
});

test('tool registry is isolated between independent MCP server instances', () => {
  const a = fakeServer().server;
  const b = fakeServer().server;
  const snapshotA = trackRegisteredMcpTools(a);
  const snapshotB = trackRegisteredMcpTools(b);
  (a.registerTool as unknown as (name: string) => void)('alpha');
  (b.registerTool as unknown as (name: string) => void)('beta');
  assert.deepEqual(snapshotA(), ['alpha']);
  assert.deepEqual(snapshotB(), ['beta']);
});
