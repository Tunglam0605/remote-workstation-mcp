import assert from 'node:assert/strict';
import test from 'node:test';
import { startSetupServer } from '../src/setup/setup-server.js';

test('Setup & Control Center requires the ephemeral token for API access', async () => {
  const setup = await startSetupServer({ repoRoot: process.cwd(), port: 23180, openBrowser: false });
  try {
    const parsed = new URL(setup.url);
    const token = parsed.hash.replace(/^#token=/, '');
    const base = `${parsed.protocol}//${parsed.host}`;

    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Remote Workstation MCP Setup & Control Center/);

    const missing = await fetch(`${base}/api/status`);
    assert.equal(missing.status, 403);

    const wrongOrigin = await fetch(`${base}/api/status`, {
      headers: {
        'x-rwmcp-setup-token': decodeURIComponent(token),
        origin: 'https://example.invalid'
      }
    });
    assert.equal(wrongOrigin.status, 403);

    const ok = await fetch(`${base}/api/status`, {
      headers: { 'x-rwmcp-setup-token': decodeURIComponent(token) }
    });
    assert.equal(ok.status, 200);
    const body = await ok.json() as { version: string; settings: { mcpPort: number } };
    assert.equal(body.version, '0.7.5');
    assert.ok(Number.isInteger(body.settings.mcpPort));
  } finally {
    await setup.close();
  }
});
