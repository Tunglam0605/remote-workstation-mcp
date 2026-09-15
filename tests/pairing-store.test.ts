import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PairingStore } from '../src/pairing/pairing-store.js';

async function tempStore(now: () => Date) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-pairing-test-'));
  return { dir, store: new PairingStore(path.join(dir, 'devices.json'), now) };
}

test('pairing code is one-time, credential is hashed at rest, and public inventory hides it', async () => {
  let current = new Date('2026-09-15T10:00:00Z');
  const { dir, store } = await tempStore(() => current);
  try {
    const pair = await store.createCode({ requestedName: 'Ubuntu Lab', bootstrapHostId: 'ubuntu-lab', ttlSeconds: 600 });
    assert.match(pair.code, /^RWMCP-(?:[A-F0-9]{4}-){4}[A-F0-9]{4}$/);
    const claimed = await store.claim(pair.code, {
      name: 'Ubuntu Lab', hostname: 'lab-host', platform: 'linux', arch: 'x86_64', version: '0.8.2',
      capabilities: ['paired.identity'], bootstrapTransport: 'ssh', bootstrapHostId: 'ubuntu-lab'
    }, { deviceId: 'dev_test_device', credential: 'rwmcp_dev_abcdefghijklmnopqrstuvwxyzABCDEFGH1234567890' });
    assert.equal(claimed.device.id, 'dev_test_device');
    assert.ok(claimed.credential.startsWith('rwmcp_dev_'));
    assert.equal(await store.verifyCredential(claimed.device.id, claimed.credential), true);
    const inventory = await store.listDevices();
    assert.equal(inventory.length, 1);
    assert.equal('credentialHash' in (inventory[0] as object), false);
    const raw = await fs.readFile(path.join(dir, 'devices.json'), 'utf8');
    assert.doesNotMatch(raw, new RegExp(claimed.credential.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(raw, /"credentialHash"/);
    await assert.rejects(() => store.claim(pair.code, {
      name: 'Again', hostname: 'again', platform: 'linux', version: '0.8.2', bootstrapTransport: 'ssh'
    }), /already been used/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('pairing codes expire and revoked device credentials stop verifying', async () => {
  let current = new Date('2026-09-15T10:00:00Z');
  const { dir, store } = await tempStore(() => current);
  try {
    const expired = await store.createCode({ ttlSeconds: 60 });
    current = new Date('2026-09-15T10:02:00Z');
    await assert.rejects(() => store.inspectCode(expired.code), /expired/);

    const active = await store.createCode({ ttlSeconds: 600 });
    const result = await store.claim(active.code, {
      name: 'PC', hostname: 'pc', platform: 'linux', version: '0.8.2', bootstrapTransport: 'manual'
    }, { deviceId: 'dev_revoke_test', credential: 'rwmcp_dev_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh1234567890' });
    assert.equal(await store.verifyCredential(result.device.id, result.credential), true);
    const revoked = await store.revoke(result.device.id);
    assert.ok(revoked.revokedAt);
    assert.equal(await store.verifyCredential(result.device.id, result.credential), false);
    assert.equal((await store.listDevices()).length, 0);
    assert.equal((await store.listDevices({ includeRevoked: true })).length, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
