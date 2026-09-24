import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NAVIGATION,
  canonicalPage,
  pageFromHash,
  routeForPage
} from '../assets/moonlight/navigation.js';

test('Moonlight information architecture keeps nine stable top-level domains', () => {
  assert.deepEqual(
    NAVIGATION.map(item => item.id),
    ['Overview', 'Work', 'Agents', 'Engineering', 'Office', 'Web', 'Devices', 'Security', 'System']
  );
  assert.equal(new Set(NAVIGATION.map(item => item.route)).size, NAVIGATION.length);
});

test('legacy page names and hashes remain backward compatible', () => {
  assert.equal(canonicalPage('Execution'), 'Agents');
  assert.equal(canonicalPage('Access'), 'Security');
  assert.equal(canonicalPage('Updates'), 'System');
  assert.equal(canonicalPage('Settings'), 'System');

  assert.equal(pageFromHash('#execution'), 'Execution');
  assert.equal(pageFromHash('#access'), 'Access');
  assert.equal(pageFromHash('#updates'), 'Updates');
  assert.equal(pageFromHash('#settings'), 'Settings');

  assert.equal(routeForPage('Execution'), 'agents');
  assert.equal(routeForPage('Access'), 'security');
  assert.equal(routeForPage('Updates'), 'system');
  assert.equal(routeForPage('Settings'), 'system');
});

test('implementation details do not become top-level navigation items', () => {
  const labels = new Set(NAVIGATION.map(item => item.id));
  for (const forbidden of [
    'Codex', 'Antigravity', 'Playwright', 'Existing Chrome',
    'NotebookLM', 'Word', 'Excel', 'PowerPoint', 'COM', 'OOXML'
  ]) assert.equal(labels.has(forbidden), false);
});
