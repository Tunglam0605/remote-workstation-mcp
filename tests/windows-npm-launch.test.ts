import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveAuthorizedNpmLaunch } from '../src/adapters/windows-npm-launch.ts';

async function fixture(t: { after: (fn: () => Promise<void>) => void }): Promise<{ directory: string; cli: string }> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-npm-shim-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 3 }));
  const cli = path.join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  await fs.mkdir(path.dirname(cli), { recursive: true });
  await fs.writeFile(path.join(directory, 'npm.cmd'), '@echo off\r\n');
  await fs.writeFile(cli, 'console.log("npm fixture")\n');
  return { directory, cli };
}

test('owner-authorized Windows npm runs through npm-cli.js without a shell', { skip: process.platform !== 'win32' }, async t => {
  const { directory, cli } = await fixture(t);
  const args = ['run', 'verify', '--', 'x&y', 'two words', '%PATH%', 'a"b'];
  const resolved = resolveAuthorizedNpmLaunch('npm', args, {
    platform: 'win32',
    env: { PATH: directory },
    nodeExecutable: 'C:\\Tools\\node.exe'
  });
  assert.deepEqual(resolved, { program: 'C:\\Tools\\node.exe', args: [cli, ...args] });
  assert.deepEqual(args, ['run', 'verify', '--', 'x&y', 'two words', '%PATH%', 'a"b']);
});

test('explicit owner-authorized npm.cmd uses the same no-shell launch', { skip: process.platform !== 'win32' }, async t => {
  const { directory, cli } = await fixture(t);
  const resolved = resolveAuthorizedNpmLaunch(path.join(directory, 'npm.cmd'), ['--version'], {
    platform: 'win32',
    env: { PATH: '' },
    nodeExecutable: 'C:\\Tools\\node.exe'
  });
  assert.deepEqual(resolved, { program: 'C:\\Tools\\node.exe', args: [cli, '--version'] });
});

test('missing companion npm-cli.js fails closed rather than invoking cmd.exe', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-npm-missing-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 3 }));
  await fs.writeFile(path.join(directory, 'npm.cmd'), '@echo off\r\n');
  assert.throws(() => resolveAuthorizedNpmLaunch('npm', ['--version'], {
    platform: 'win32', env: { PATH: directory }, nodeExecutable: 'C:\\Tools\\node.exe'
  }), /npm-cli\.js|companion/i);
});

test('Linux native npm and unrelated Windows cmd tools are untouched', () => {
  const args = ['--version'];
  const options = { platform: 'linux', env: { PATH: '/usr/bin' }, nodeExecutable: '/usr/bin/node' };
  assert.deepEqual(resolveAuthorizedNpmLaunch('npm', args, options), { program: 'npm', args });
  assert.deepEqual(resolveAuthorizedNpmLaunch('custom.cmd', args, { ...options, platform: 'win32' }), {
    program: 'custom.cmd', args
  });
});
