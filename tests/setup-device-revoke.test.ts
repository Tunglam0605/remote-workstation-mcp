import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PairingStore } from '../src/pairing/pairing-store.js';
import { startSetupServer } from '../src/setup/setup-server.js';

test('the owner-token-protected setup route revokes an active paired device', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-setup-revoke-'));
  const originalLocalAppData = process.env.LOCALAPPDATA;
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.LOCALAPPDATA = path.join(root, 'local-app-data');
  process.env.XDG_CONFIG_HOME = path.join(root, 'xdg-config');
  let setup: Awaited<ReturnType<typeof startSetupServer>> | undefined;
  t.after(async () => {
    await setup?.close();
    if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = originalLocalAppData;
    if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    await fs.rm(root, { recursive: true, force: true });
  });

  const pairing = new PairingStore();
  const code = await pairing.createCode();
  const claimed = await pairing.claim(code.code, {
    name: 'Fixture device', hostname: 'fixture-host', platform: 'linux', version: '1.0.0',
    bootstrapTransport: 'manual'
  }, { deviceId: 'fixture-device-01', credential: 'rwmcp_dev_12345678901234567890123456789012' });
  setup = await startSetupServer({ repoRoot: process.cwd(), port: 23182, openBrowser: false });
  const page = await fetch(setup.url);
  const token = (await page.text()).match(/rwmcp-setup-token" content="([A-Za-z0-9_-]+)"/)?.[1];
  assert.ok(token);
  const base = new URL(setup.url).origin;

  const denied = await fetch(`${base}/api/devices/${claimed.device.id}/revoke`, { method: 'POST' });
  assert.equal(denied.status, 403);
  const revoked = await fetch(`${base}/api/devices/${claimed.device.id}/revoke`, {
    method: 'POST', headers: { 'x-rwmcp-setup-token': token }
  });
  assert.equal(revoked.status, 200);
  const body = await revoked.json() as { id: string; revokedAt?: string; credentialHash?: string };
  assert.equal(body.id, claimed.device.id);
  assert.ok(body.revokedAt);
  assert.equal(body.credentialHash, undefined);
  assert.equal(await pairing.verifyCredential(claimed.device.id, 'rwmcp_dev_12345678901234567890123456789012'), false);
});
