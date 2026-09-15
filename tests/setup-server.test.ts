import assert from 'node:assert/strict';
import test from 'node:test';
import { startSetupServer } from '../src/setup/setup-server.js';

test('Setup & Control Center requires the ephemeral token for API access', async () => {
  const setup = await startSetupServer({ repoRoot: process.cwd(), port: 23180, openBrowser: false });
  try {
    const parsed = new URL(setup.url);
    assert.equal(parsed.hash, '');
    const base = `${parsed.protocol}//${parsed.host}`;

    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    const pageText = await page.text();
    assert.match(pageText, /Remote Workstation MCP Setup & Control Center/);
    assert.match(pageText, /id="langEn"/);
    assert.match(pageText, /id="langVi"/);
    assert.match(pageText, /id="enableFullControl"/);
    assert.match(pageText, /id="disableFullControl"/);
    assert.match(pageText, /Thiết lập nhanh cho ChatGPT/);
    assert.match(pageText, /rwmcp\.language/);
    assert.match(pageText, /navigator\.language/);
    const tokenMatch = pageText.match(/const token = ("[^"]+");/);
    assert.ok(tokenMatch, 'Control Center page should embed an ephemeral CSRF token.');
    const token = JSON.parse(tokenMatch[1]!) as string;
    assert.ok(token.length >= 32);
    assert.ok(!setup.url.includes(token), 'CSRF token must not be placed in the URL.');

    const missing = await fetch(`${base}/api/status`);
    assert.equal(missing.status, 403);

    const wrongOrigin = await fetch(`${base}/api/status`, {
      headers: {
        'x-rwmcp-setup-token': token,
        origin: 'https://example.invalid'
      }
    });
    assert.equal(wrongOrigin.status, 403);

    const ok = await fetch(`${base}/api/status`, {
      headers: { 'x-rwmcp-setup-token': token }
    });
    assert.equal(ok.status, 200);
    const body = await ok.json() as { version: string; settings: { mcpPort: number } };
    assert.equal(body.version, '0.7.6');
    assert.ok(Number.isInteger(body.settings.mcpPort));
  } finally {
    await setup.close();
  }
});
