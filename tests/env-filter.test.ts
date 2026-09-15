import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSafeEnvironment } from '../src/security/env-filter.js';

test('environment filter only inherits explicit non-secret names', () => {
  const source = { PATH: '/bin', HOME: '/tmp/home', GITHUB_TOKEN: 'secret', DATABASE_PASSWORD: 'secret' };
  const result = buildSafeEnvironment(['PATH', 'HOME', 'GITHUB_TOKEN', 'DATABASE_PASSWORD'], source);
  assert.deepEqual(result, { PATH: '/bin', HOME: '/tmp/home' });
});

test('Windows runtime environment retains ProgramData for OpenSSH configuration discovery', { skip: process.platform !== 'win32' }, () => {
  const result = buildSafeEnvironment([], { ProgramData: 'C:\\ProgramData' });
  assert.equal(result.ProgramData, 'C:\\ProgramData');
});
