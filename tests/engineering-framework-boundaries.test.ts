import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const NETWORK_TOOLS = [
  'network_provider_status',
  'network_interface_list',
  'network_route_list',
  'network_dns_lookup',
  'network_ping',
  'network_tcp_reachability'
] as const;

const SERIAL_TOOLS = [
  'serial_open',
  'serial_read',
  'serial_wait_for_text',
  'serial_write',
  'serial_close'
] as const;

const TERMINAL_TOOLS = [
  'terminal_start',
  'terminal_read',
  'terminal_write',
  'terminal_resize',
  'terminal_stop'
] as const;

function registeredTools(source: string): string[] {
  return [...source.matchAll(/server\.registerTool\('([^']+)'/g)].map(match => match[1]);
}

test('generic engineering MCP families stay modularized outside the composition monolith', async () => {
  const [composition, network, serial, terminal] = await Promise.all([
    fs.readFile(path.resolve('src/tools/engineering-tools.ts'), 'utf8'),
    fs.readFile(path.resolve('src/engineering/mcp/network-tools.ts'), 'utf8'),
    fs.readFile(path.resolve('src/engineering/mcp/serial-tools.ts'), 'utf8'),
    fs.readFile(path.resolve('src/engineering/mcp/terminal-tools.ts'), 'utf8')
  ]);

  const compositionTools = new Set(registeredTools(composition));
  for (const tool of [...NETWORK_TOOLS, ...SERIAL_TOOLS, ...TERMINAL_TOOLS]) {
    assert.equal(compositionTools.has(tool), false, `${tool} must not drift back into engineering-tools.ts`);
  }

  assert.deepEqual(registeredTools(network), [...NETWORK_TOOLS]);
  assert.deepEqual(registeredTools(serial), [...SERIAL_TOOLS]);
  assert.deepEqual(registeredTools(terminal), [...TERMINAL_TOOLS]);

  assert.match(composition, /registerEngineeringNetworkTools\(server, ctx\);/);
  assert.match(composition, /registerEngineeringSerialTools\(server, ctx\);/);
  assert.match(composition, /registerEngineeringTerminalTools\(server, ctx\);/);
});
