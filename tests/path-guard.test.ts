import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { PolicyConfig } from '../src/model.js';
import { PolicyEngine } from '../src/policy.js';
import { PathGuard } from '../src/security/path-guard.js';

test('path guard blocks traversal and symlink escape', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-'));
  const root = path.join(base, 'root');
  const outside = path.join(base, 'outside');
  await fs.mkdir(root);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(root, 'ok.txt'), 'ok');
  await fs.writeFile(path.join(outside, 'secret.txt'), 'secret');
  await fs.symlink(outside, path.join(root, 'escape'), os.platform() === 'win32' ? 'junction' : 'dir');
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const config: PolicyConfig = {
    version: 1, mode: 'workspace', workspaces: [{ id: 'w', root }],
    filesystem: { maxReadBytes: 1024, maxWriteBytes: 1024 },
    process: { allowExecutables: [], inheritEnv: [], maxOutputBytes: 1024, maxRuntimeMs: 1000 }
  };
  const guard = new PathGuard(new PolicyEngine(config));
  assert.equal(await guard.resolveExisting('w', 'ok.txt'), path.join(root, 'ok.txt'));
  await assert.rejects(() => guard.resolveExisting('w', '../outside/secret.txt'));
  await assert.rejects(() => guard.resolveExisting('w', 'escape/secret.txt'));
});
