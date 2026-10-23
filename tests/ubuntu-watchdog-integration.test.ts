import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('Ubuntu watchdog regression suite passes without touching running services', {
  skip: process.platform !== 'linux'
}, () => {
  const result = spawnSync('python3', [
    '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'ubuntu_watchdog_test.py'
  ], {
    timeout: 15_000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    encoding: 'utf8'
  });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stderr, /Ran 9 tests/);
  assert.match(result.stderr, /OK/);
});
