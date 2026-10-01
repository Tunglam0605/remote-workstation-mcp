import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { findJsonObservations } from '../src/extensions/mqtt/json-observer.js';
import {
  encodeConnectPacket,
  encodeSubscribePacket,
  parsePublishPacket,
  validateTopicFilter,
  type ParsedPacket
} from '../src/extensions/mqtt/mqtt-client.js';
import { MqttProfileStore } from '../src/extensions/mqtt/profile-store.js';

test('MQTT CONNECT packet uses protocol level 4 and enforces username with credential data', () => {
  const packet = encodeConnectPacket({ username: 'user', password: 'credential-fixture' }, 'rwmcp-test');
  assert.equal(packet[0], 0x10);
  const mqttIndex = packet.indexOf(Buffer.from('MQTT'));
  assert.notEqual(mqttIndex, -1);
  assert.equal(packet[mqttIndex + 4], 0x04);
  assert.throws(() => encodeConnectPacket({ password: 'credential-fixture' }, 'rwmcp-test'), /password requires username/i);
});

test('MQTT topic filter validation enforces wildcard placement', () => {
  assert.equal(validateTopicFilter('plant/line1/+/state'), 'plant/line1/+/state');
  assert.equal(validateTopicFilter('plant/#'), 'plant/#');
  assert.throws(() => validateTopicFilter('plant/a#'), /wildcard/i);
  assert.throws(() => validateTopicFilter('plant/#/state'), /wildcard/i);
  assert.throws(() => validateTopicFilter('plant/a+b'), /wildcard/i);
});

test('MQTT SUBSCRIBE packet is QoS0 and uses required 0x82 fixed header', () => {
  const packet = encodeSubscribePacket('a/b', 0x1234);
  assert.equal(packet[0], 0x82);
  assert.ok(packet.includes(Buffer.from([0x12, 0x34])));
  assert.equal(packet.at(-1), 0x00);
});

test('MQTT PUBLISH parser returns bounded JSON evidence', () => {
  const topic = Buffer.from('plant/line1/sensor-7/state');
  const payload = Buffer.from(JSON.stringify({ type: 'telemetry', temperature: 24.5, healthy: true }));
  const body = Buffer.concat([Buffer.from([topic.length >> 8, topic.length & 0xff]), topic, payload]);
  const packet: ParsedPacket = { type: 3, flags: 0, payload: body };
  const parsed = parsePublishPacket(packet, 65_536);
  assert.equal(parsed?.topic, 'plant/line1/sensor-7/state');
  assert.equal(parsed?.qos, 0);
  assert.deepEqual(parsed?.json, { type: 'telemetry', temperature: 24.5, healthy: true });
});

test('generic JSON observer finds nested objects by property/value and returns selected scalar fields', () => {
  const found = findJsonObservations({
    header: { id: 1 },
    data: [
      { type: 'other' },
      { payload: { type: 'telemetry', temperature: 24.5, healthy: true, nested: { ignored: true } } }
    ]
  }, {
    matchField: 'type',
    matchEquals: 'telemetry',
    selectFields: ['temperature', 'healthy', 'nested']
  });
  assert.deepEqual(found, [{
    path: '$.data[1].payload',
    matchedField: 'type',
    matchedValue: 'telemetry',
    selected: { temperature: 24.5, healthy: true }
  }]);
});

test('generic JSON observer is bounded and does not return non-scalar selected values', () => {
  assert.throws(() => findJsonObservations({}, { matchField: 'bad key' }), /matchField/i);
  assert.throws(() => findJsonObservations({}, { matchField: 'type', maxDepth: 9 }), /maxDepth/i);
  const matches = findJsonObservations({ type: 'state', object: { secret: 'not-returned-as-object' }, value: null }, {
    matchField: 'type',
    selectFields: ['object', 'value']
  });
  assert.deepEqual(matches[0]?.selected, { value: null });
});

test('MQTT profile status reports credential readiness without returning credential material', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-mqtt-'));
  const file = path.join(root, 'mqtt-profiles.json');
  await fs.writeFile(file, JSON.stringify({
    version: 1,
    profiles: [{
      id: 'plant',
      host: '127.0.0.1',
      port: 1883,
      tls: false,
      username: 'operator',
      passwordEnv: 'TEST_MQTT_PASSWORD'
    }]
  }));
  const store = new MqttProfileStore(file, { TEST_MQTT_PASSWORD: 'credential-fixture-value' });
  const status = await store.status();
  assert.equal(status.profileCount, 1);
  assert.equal(status.profiles[0]?.passwordConfigured, true);
  assert.doesNotMatch(JSON.stringify(status), /credential-fixture-value/);
  assert.doesNotMatch(JSON.stringify(status), /TEST_MQTT_PASSWORD/);
  const resolved = await store.resolve('plant');
  assert.equal(resolved.password, 'credential-fixture-value');
  await fs.rm(root, { recursive: true, force: true });
});

test('MQTT profile validation rejects URL-like broker hosts', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-mqtt-'));
  const file = path.join(root, 'mqtt-profiles.json');
  await fs.writeFile(file, JSON.stringify({
    version: 1,
    profiles: [{ id: 'bad', host: 'mqtt://broker.local', port: 1883, tls: false }]
  }));
  const store = new MqttProfileStore(file, {});
  await assert.rejects(() => store.status(), /hostname or IP address|invalid/);
  await fs.rm(root, { recursive: true, force: true });
});
