import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import {
  parseRos2NativeBandwidthPayload,
  parseRos2NativeRatePayload,
  parseRos2NativeTransformPayload
} from '../src/adapters/engineering/ros2-analysis.js';

test('ROS 2 native helper JSON contract normalizes typed rate and bandwidth samples', () => {
  assert.deepEqual(parseRos2NativeRatePayload({
    sample: {
      averageHz: 100,
      minPeriodSeconds: 0.009,
      maxPeriodSeconds: 0.011,
      stdDevSeconds: 0.0005,
      window: 50
    }
  }), {
    averageHz: 100,
    minPeriodSeconds: 0.009,
    maxPeriodSeconds: 0.011,
    stdDevSeconds: 0.0005,
    window: 50,
    raw: ''
  });

  assert.deepEqual(parseRos2NativeBandwidthPayload({
    sample: {
      bytesPerSecond: 2_000_000,
      messageCount: 20,
      meanMessageBytes: 100_000,
      minMessageBytes: 90_000,
      maxMessageBytes: 110_000
    }
  }), {
    bytesPerSecond: 2_000_000,
    messageCount: 20,
    meanMessageBytes: 100_000,
    minMessageBytes: 90_000,
    maxMessageBytes: 110_000,
    raw: ''
  });
});

test('ROS 2 native helper JSON contract normalizes TF without text parsing', () => {
  assert.deepEqual(parseRos2NativeTransformPayload({
    transform: {
      translation: { x: 0.1, y: 0.2, z: 0.3 },
      rotationQuaternion: { x: 0, y: 0, z: 0, w: 1 },
      time: '42.000000000'
    }
  }), {
    translation: { x: 0.1, y: 0.2, z: 0.3 },
    rotationQuaternion: { x: 0, y: 0, z: 0, w: 1 },
    time: '42.000000000'
  });
});

test('ROS 2 native helper contract stays diagnostic-only and bounded', async () => {
  const source = await fs.readFile(new URL('../scripts/ros2-native-diagnostics.py', import.meta.url), 'utf8');
  assert.match(source, /schemaVersion/);
  assert.match(source, /create_subscription/);
  assert.match(source, /serialize_message/);
  assert.match(source, /lookup_transform\(target, source/);
  assert.doesNotMatch(source, /send_goal|create_client\(|create_service\(|create_publisher\(/);
  assert.match(source, /choices=range\(1000, 20001\)/);
});
