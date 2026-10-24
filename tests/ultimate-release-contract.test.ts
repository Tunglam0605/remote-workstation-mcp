import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const repo = path.resolve(import.meta.dirname, '..');

test('Ultimate activation stays owner-local and handoff contributions are Windows-only', async () => {
  const [server, tools, context, setup] = await Promise.all([
    fs.readFile(path.join(repo, 'src/setup/setup-server.ts'), 'utf8'),
    fs.readFile(path.join(repo, 'src/tools/chatgpt-web-tools.ts'), 'utf8'),
    fs.readFile(path.join(repo, 'src/context.ts'), 'utf8'),
    fs.readFile(path.join(repo, 'src/setup/ultimate-control.ts'), 'utf8')
  ]);
  assert.match(server, /'\/api\/ultimate\/activate'/);
  assert.match(server, /'\/api\/ultimate' && req\.method === 'DELETE'/);
  assert.match(tools, /registerTool\('ultimate_control_status'/);
  assert.doesNotMatch(tools, /registerTool\('ultimate_(?:activate|renew|revoke)'/);
  assert.match(context, /if \(process\.platform === 'win32'\) \{\s*for \(const contribution of createHandoffWorkflowContributions/);
  assert.match(setup, /runtimePlatform !== 'win32'/);
});
