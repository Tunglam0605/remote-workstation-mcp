import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FilesystemAdapter } from '../src/adapters/filesystem.js';
import type { PolicyConfig } from '../src/model.js';
import { PolicyEngine } from '../src/policy.js';
import { PathGuard } from '../src/security/path-guard.js';

test('filesystem optimistic concurrency rejects stale agents', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-concurrency-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'demo.txt'), 'alpha\n', 'utf8');

  const config: PolicyConfig = {
    version: 1,
    mode: 'workspace',
    workspaces: [{ id: 'demo', root, readOnly: false }],
    filesystem: { maxReadBytes: 1024 * 1024, maxWriteBytes: 1024 * 1024 },
    process: { allowExecutables: [], inheritEnv: [], maxOutputBytes: 1024, maxRuntimeMs: 1000 }
  };
  const policy = new PolicyEngine(config);
  const adapter = new FilesystemAdapter(policy, new PathGuard(policy));

  const first = await adapter.read('demo', 'demo.txt');
  const patched = await adapter.patch('demo', 'demo.txt', 'alpha', 'beta', 1, first.sha256);
  assert.equal((await adapter.read('demo', 'demo.txt')).content, 'beta\n');
  assert.match(patched.sha256, /^[a-f0-9]{64}$/);

  await assert.rejects(
    adapter.patch('demo', 'demo.txt', 'beta', 'gamma', 1, first.sha256),
    /Concurrency conflict/
  );

  const current = await adapter.read('demo', 'demo.txt');
  await adapter.write('demo', 'demo.txt', 'gamma\n', true, current.sha256);
  await assert.rejects(
    adapter.write('demo', 'demo.txt', 'delta\n', true, current.sha256),
    /Concurrency conflict/
  );
});
