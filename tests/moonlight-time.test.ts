import assert from 'node:assert/strict';
import test from 'node:test';
import { greetingSource, hourInTimeZone } from '../assets/moonlight/time.js';

test('Moonlight greeting follows Asia/Ho_Chi_Minh local time', () => {
  assert.equal(hourInTimeZone(new Date('2026-09-23T03:51:00Z')), 10);
  assert.equal(greetingSource(new Date('2026-09-23T03:51:00Z')), 'Good morning,');
  assert.equal(greetingSource(new Date('2026-09-23T05:00:00Z')), 'Good afternoon,');
  assert.equal(greetingSource(new Date('2026-09-23T11:00:00Z')), 'Good evening,');
});

test('Moonlight greeting boundaries are deterministic', () => {
  assert.equal(greetingSource(new Date('2026-09-22T22:00:00Z')), 'Good morning,'); // 05:00 +07
  assert.equal(greetingSource(new Date('2026-09-23T05:00:00Z')), 'Good afternoon,'); // 12:00 +07
  assert.equal(greetingSource(new Date('2026-09-23T11:00:00Z')), 'Good evening,'); // 18:00 +07
});
