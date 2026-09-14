import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { PolicyConfig } from '../src/model.js';
import { PolicyEngine } from '../src/policy.js';
import { PathGuard } from '../src/security/path-guard.js';
import { SearchAdapter } from '../src/adapters/search.js';

test('search adapter finds file names and text without following symlinks', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-search-'));
  const root = path.join(base, 'root');
  const outside = path.join(base, 'outside');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(outside);
  await fs.writeFile(path.join(root, 'src', 'motor-control.ts'), 'const speedRef = 42;\n');
  await fs.writeFile(path.join(outside, 'secret.ts'), 'speedRef=999\n');
  await fs.symlink(outside, path.join(root, 'escape'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const config: PolicyConfig = {
    version: 1,
    mode: 'workspace',
    workspaces: [{ id: 'w', root }],
    filesystem: { maxReadBytes: 1024, maxWriteBytes: 1024 },
    search: { maxResults: 20, maxFiles: 100, maxFileBytes: 1024 },
    process: { allowExecutables: [], inheritEnv: [], maxOutputBytes: 1024, maxRuntimeMs: 1000 },
    tasks: {}
  };
  const policy = new PolicyEngine(config);
  const search = new SearchAdapter(policy, new PathGuard(policy));

  const files = await search.findFiles('w', 'motor');
  assert.equal(files.length, 1);
  assert.equal(files[0].path, path.join('src', 'motor-control.ts'));

  const matches = await search.searchText('w', 'speedRef');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].line, 1);
  assert.match(matches[0].path, /motor-control\.ts$/);
});
