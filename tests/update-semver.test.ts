import assert from 'node:assert/strict';
import test from 'node:test';
import { compareSemver, isPatchUpgrade, normalizeVersion, parseSemver } from '../scripts/lib/semver.mjs';

test('normalizes and parses release versions', () => {
  assert.equal(normalizeVersion(' v0.5.1 '), '0.5.1');
  assert.deepEqual(parseSemver('v1.2.3'), { major: 1, minor: 2, patch: 3 });
  assert.deepEqual(parseSemver('1.2.3+build.7'), { major: 1, minor: 2, patch: 3 });
  assert.equal(parseSemver('latest'), undefined);
});

test('semantic comparison never treats an older release as newer', () => {
  assert.equal(compareSemver('0.5.1', '0.5.0'), 1);
  assert.equal(compareSemver('0.5.0', '0.5.1'), -1);
  assert.equal(compareSemver('1.0.0', '0.99.99'), 1);
  assert.equal(compareSemver('0.5.1', '0.5.1'), 0);
  assert.throws(() => compareSemver('latest', '0.5.1'));
});

test('auto_patch only accepts a higher patch in the same major/minor line', () => {
  assert.equal(isPatchUpgrade('0.5.0', '0.5.1'), true);
  assert.equal(isPatchUpgrade('0.5.1', '0.5.0'), false);
  assert.equal(isPatchUpgrade('0.5.1', '0.6.0'), false);
  assert.equal(isPatchUpgrade('0.5.1', '1.5.2'), false);
});
