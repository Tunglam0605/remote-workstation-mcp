import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('secret scan keeps successful stdout empty for npm pack command substitution', () => {
  const result = spawnSync(process.execPath, ['scripts/check-secret-leaks.mjs'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || 'secret scan failed');
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Secret scan: OK/);
});
