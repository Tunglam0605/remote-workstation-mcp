import assert from 'node:assert/strict';
import test from 'node:test';
import { startSetupServer } from '../src/setup/setup-server.js';

test('Control Center exposes owner-local Windows update status/config APIs', async () => {
  const setup = await startSetupServer({ repoRoot: process.cwd(), port: 23181, openBrowser: false });
  try {
    const page = await fetch(setup.url);
    const html = await page.text();
    const match = html.match(/const token = ("[^"]+");/);
    assert.ok(match);
    const token = JSON.parse(match[1]!) as string;
    const headers = { 'x-rwmcp-setup-token': token };

    const statusResponse = await fetch(`${setup.url}api/update/status`, { headers });
    assert.equal(statusResponse.status, 200);
    const status = await statusResponse.json() as { supported?: boolean; enabled?: boolean; channel?: string; automaticPolicy?: string };
    assert.equal(status.supported, true);
    assert.equal(typeof status.enabled, 'boolean');
    assert.equal(status.channel, 'stable');
    assert.equal(status.automaticPolicy, 'patch');

    const invalidConfig = await fetch(`${setup.url}api/update/config`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: 'yes' })
    });
    assert.equal(invalidConfig.status, 400);
  } finally {
    await setup.close();
  }
});
