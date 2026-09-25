import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRos2LifecycleState, parseRos2TopicBandwidth, parseRos2TopicHz, parseTf2Echo } from '../src/adapters/engineering/ros2-analysis.js';

test('ROS 2 topic hz parser selects the latest bounded sample', () => {
  const parsed = parseRos2TopicHz(`average rate: 9.900\n\tmin: 0.099s max: 0.103s std dev: 0.00100s window: 9\naverage rate: 10.020\n\tmin: 0.098s max: 0.102s std dev: 0.00080s window: 20\n`);
  assert.deepEqual(parsed, {
    averageHz: 10.02,
    minPeriodSeconds: 0.098,
    maxPeriodSeconds: 0.102,
    stdDevSeconds: 0.0008,
    window: 20,
    raw: parsed.raw
  });
});

test('ROS 2 topic bandwidth parser normalizes SI and binary units to bytes', () => {
  const parsed = parseRos2TopicBandwidth(`Subscribed to [/image]\n1.50 MB/s from 10 messages\n\tMessage size mean: 150.00 KB min: 140.00 KB max: 160.00 KB\n`);
  assert.equal(parsed.bytesPerSecond, 1_500_000);
  assert.equal(parsed.messageCount, 10);
  assert.equal(parsed.meanMessageBytes, 150_000);
  assert.equal(parsed.minMessageBytes, 140_000);
  assert.equal(parsed.maxMessageBytes, 160_000);
});

test('TF2 echo parser returns the latest transform sample', () => {
  const parsed = parseTf2Echo(`At time 10.0\n- Translation: [1.000, 2.000, 3.000]\n- Rotation: in Quaternion [0.000, 0.000, 0.100, 0.995]\nAt time 11.0\n- Translation: [1.100, 2.200, 3.300]\n- Rotation: in Quaternion [0.000, 0.000, 0.200, 0.980]\n`);
  assert.deepEqual(parsed, {
    translation: { x: 1.1, y: 2.2, z: 3.3 },
    rotationQuaternion: { x: 0, y: 0, z: 0.2, w: 0.98 },
    time: '11.0'
  });
});

test('lifecycle parser extracts state label and numeric id while preserving raw fallback', () => {
  assert.deepEqual(parseRos2LifecycleState('active [3]\n'), { label: 'active', id: 3, raw: 'active [3]' });
  assert.deepEqual(parseRos2LifecycleState('unknown output'), { raw: 'unknown output' });
});
