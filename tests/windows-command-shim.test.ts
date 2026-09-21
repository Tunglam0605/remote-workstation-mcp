import assert from 'node:assert/strict';
import test from 'node:test';
import { windowsCommandShim } from '../src/adapters/windows-command-shim.js';

test('Windows cmd/bat shims use ComSpec without enabling shell mode', () => {
  const invocation = windowsCommandShim(
    'C:\\Users\\Admin\\AppData\\Roaming\\npm\\codex.cmd',
    ['login', 'status'],
    { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    'win32'
  );

  assert.equal(invocation.program, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(invocation.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(invocation.windowsVerbatimArguments, true);
  assert.match(invocation.args[3] ?? '', /codex\.cmd/);
  assert.match(invocation.args[3] ?? '', /"login" "status"/);
});

test('native executables and non-Windows programs remain direct spawn targets', () => {
  assert.deepEqual(
    windowsCommandShim('C:\\Tools\\codex.exe', ['--version'], {}, 'win32'),
    {
      program: 'C:\\Tools\\codex.exe',
      args: ['--version'],
      windowsVerbatimArguments: false
    }
  );
  assert.deepEqual(
    windowsCommandShim('/usr/local/bin/codex', ['--version'], {}, 'linux'),
    {
      program: '/usr/local/bin/codex',
      args: ['--version'],
      windowsVerbatimArguments: false
    }
  );
});
