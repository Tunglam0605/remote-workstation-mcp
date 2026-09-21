import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { codexCliStatus } from '../src/setup/setup-server.js';

test('Control Center Codex probe handles Windows npm cmd shim and authenticated status', { skip: process.platform !== 'win32' }, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-setup-codex-'));
  const originalPath = process.env.PATH;
  const originalPathext = process.env.PATHEXT;
  try {
    const shim = path.join(temp, 'codex.cmd');
    await fs.writeFile(shim, [
      '@echo off',
      'if "%~1"=="--version" echo codex-cli 9.9.9 & exit /b 0',
      'if "%~1"=="login" echo Logged in using ChatGPT & exit /b 0',
      'exit /b 2',
      ''
    ].join('\r\n'), 'utf8');

    process.env.PATH = [temp, originalPath ?? ''].filter(Boolean).join(path.delimiter);
    process.env.PATHEXT = '.EXE;.CMD;.BAT;.COM';

    const status = await codexCliStatus(temp);
    assert.deepEqual(status, {
      installed: true,
      authenticated: true,
      version: 'codex-cli 9.9.9',
      detail: 'authenticated'
    });
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalPathext === undefined) delete process.env.PATHEXT;
    else process.env.PATHEXT = originalPathext;
    await fs.rm(temp, { recursive: true, force: true });
  }
});
