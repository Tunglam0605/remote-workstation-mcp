import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadOrCreateDeviceIdentity, recommendedChatGptAppName } from '../src/device-identity.js';

test('device identity is stable across restarts and does not depend on IP address', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-device-identity-'));
  try {
    const options = { platform: 'linux' as NodeJS.Platform, homeDir: home, env: {} };
    const first = await loadOrCreateDeviceIdentity(options, { RWMCP_DEVICE_NAME: 'Vision PC' });
    const second = await loadOrCreateDeviceIdentity(options, { RWMCP_DEVICE_NAME: 'Vision PC' });
    assert.match(first.id, /^dev_[0-9a-f]{24}$/);
    assert.equal(second.id, first.id);
    assert.equal(second.name, 'Vision PC');
    assert.equal(recommendedChatGptAppName(second), 'Remote Workstation - Vision PC');
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('explicit RWMCP_DEVICE_ID is accepted only during first identity creation', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-device-identity-explicit-'));
  try {
    const options = { platform: 'linux' as NodeJS.Platform, homeDir: home, env: {} };
    const first = await loadOrCreateDeviceIdentity(options, { RWMCP_DEVICE_ID: 'lab-pc-01', RWMCP_DEVICE_NAME: 'Lab PC' });
    const second = await loadOrCreateDeviceIdentity(options, { RWMCP_DEVICE_ID: 'other-id', RWMCP_DEVICE_NAME: 'Lab PC' });
    assert.equal(first.id, 'lab-pc-01');
    assert.equal(second.id, 'lab-pc-01');
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});
