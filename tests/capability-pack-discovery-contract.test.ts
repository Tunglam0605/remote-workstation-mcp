import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

test('capabilities_list gains pack-aware output without changing its public input contract', async () => {
  const source = await fs.readFile('src/tools/core-tools.ts', 'utf8');
  const start = source.indexOf("server.registerTool('capabilities_list'");
  const end = source.indexOf("server.registerTool('system_info'", start);
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end);

  assert.match(block, /inputSchema: z\.object\(\{\}\)/);
  assert.match(block, /readOnlyHint: true/);
  assert.match(block, /describeOpenAiToolExposure/);
  assert.match(block, /describeOpenAiToolPackCatalog/);
  assert.match(block, /describeCapabilityToolExposure/);
  assert.match(block, /currentPrincipal\(\)\?\.type \?\? ctx\.actor\.clientType/);
});

test('pack-aware discovery does not create a competing MCP catalog tool or overload tool_discover', async () => {
  const source = await fs.readFile('src/tools/core-tools.ts', 'utf8');
  assert.doesNotMatch(source, /registerTool\('(?:tool_pack|capability_pack|mcp_tool)_/);
  const start = source.indexOf("server.registerTool('tool_discover'");
  const end = source.indexOf("server.registerTool('update_check'", start);
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end);
  assert.match(block, /Discover common development\/debug executables installed on the workstation/);
  assert.doesNotMatch(block, /toolPack|capabilit(?:y|ies)/i);
});
