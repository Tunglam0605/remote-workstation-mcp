import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { IndustrialProfileStore } from '../src/extensions/industrial/profile-store.js';

test('industrial profile store loads bounded non-secret Modbus RTU/TCP, OPC UA and MQTT/AGV descriptors', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-industrial-'));
  const file = path.join(root, 'industrial-endpoints.json');
  await fs.writeFile(file, JSON.stringify({
    version: 1,
    profiles: [
      { id: 'rtu1', label: 'RTU 1', kind: 'modbus-rtu', port: 'COM7', unitId: 1, baudRate: 19200 },
      { id: 'plc1', label: 'PLC 1', kind: 'modbus-tcp', host: '192.168.1.10', port: 502, unitId: 1 },
      { id: 'ua1', kind: 'opcua', endpointUrl: 'opc.tcp://192.168.1.20:4840', rootNodeId: 'ObjectsFolder' },
      { id: 'agv1', kind: 'mqtt-agv', mqttProfileId: 'agv', vehicle: 'B300_3_20' }
    ]
  }));
  const store = new IndustrialProfileStore(file);
  const list = await store.list();
  assert.equal(list.length, 4);
  assert.equal(list[0]?.kind, 'modbus-rtu');
  assert.equal(list[1]?.kind, 'modbus-tcp');
  assert.equal(list[2]?.kind, 'opcua');
  assert.equal(list[3]?.kind, 'mqtt-agv');
  const status = await store.status();
  assert.deepEqual(status, {
    configured: true,
    profileCount: 4,
    byKind: { 'modbus-rtu': 1, 'modbus-tcp': 1, opcua: 1, 'mqtt-agv': 1 }
  });
  await fs.rm(root, { recursive: true, force: true });
});

test('industrial profile store rejects duplicate ids and unknown fields', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-industrial-'));
  const file = path.join(root, 'industrial-endpoints.json');
  await fs.writeFile(file, JSON.stringify({
    version: 1,
    profiles: [
      { id: 'same', kind: 'modbus-tcp', host: '127.0.0.1', unitId: 1 },
      { id: 'same', kind: 'mqtt-agv', mqttProfileId: 'agv', vehicle: 'B300_3_20' }
    ]
  }));
  const store = new IndustrialProfileStore(file);
  await assert.rejects(() => store.list(), /Duplicate industrial profile id/);

  await fs.writeFile(file, JSON.stringify({
    version: 1,
    profiles: [{ id: 'bad', kind: 'opcua', endpointUrl: 'opc.tcp://127.0.0.1:4840', unexpected: true }]
  }));
  await assert.rejects(() => store.list());
  await fs.rm(root, { recursive: true, force: true });
});

test('industrial profile file absence is a valid empty configuration', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-industrial-'));
  const store = new IndustrialProfileStore(path.join(root, 'missing.json'));
  assert.deepEqual(await store.list(), []);
  assert.deepEqual(await store.status(), { configured: false, profileCount: 0, byKind: {} });
  await fs.rm(root, { recursive: true, force: true });
});

test('industrial profile source remains non-secret and exposes no mutation tool', async () => {
  const storeSource = await fs.readFile(new URL('../src/extensions/industrial/profile-store.ts', import.meta.url), 'utf8');
  const registerSource = await fs.readFile(new URL('../src/extensions/industrial/register.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(storeSource, /password|privateKey|clientSecret/i);
  assert.doesNotMatch(registerSource, /registerTool\('industrial_profile_(create|write|update|delete|mutate)/);
});
