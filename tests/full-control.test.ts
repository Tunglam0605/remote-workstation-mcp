import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { PermissionLease, PolicyConfig } from '../src/model.js';
import { FullControlAdapter } from '../src/adapters/full-control.js';
import { HostFilesystemAdapter } from '../src/adapters/host-filesystem.js';
import { PolicyEngine } from '../src/policy.js';

function configured(root: string): { config: PolicyConfig; lease: PermissionLease } {
  const now = Date.now();
  return {
    config: {
      version: 1,
      mode: 'workspace',
      workspaces: [{ id: 'w', root }],
      filesystem: { maxReadBytes: 4096, maxWriteBytes: 4096 },
      process: { allowExecutables: [], inheritEnv: ['PATH', 'HOME'], maxOutputBytes: 4096, maxRuntimeMs: 30000 },
      fullControl: { allowRawShell: true, allowHostFilesystem: true },
      privileged: { allowSudo: false, maxRuntimeMs: 1000 }
    },
    lease: {
      mode: 'full_control',
      issuedAt: new Date(now - 1000).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
      clientId: 'test-client'
    }
  };
}

test('full-control host filesystem requires live matching lease', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-full-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { config, lease } = configured(root);

  const denied = new HostFilesystemAdapter(new PolicyEngine(config, lease, 'other-client'));
  await assert.rejects(() => denied.list(root), /effective full_control mode/);

  const allowed = new HostFilesystemAdapter(new PolicyEngine(config, lease, 'test-client'));
  const file = path.join(root, 'note.txt');
  const created = await allowed.write(file, 'hello', false);
  assert.equal(created.bytes, 5);
  const read = await allowed.read(file);
  assert.equal(read.content, 'hello');
  await allowed.write(file, 'world', true, read.sha256);
  assert.equal((await allowed.read(file)).content, 'world');
});

test('raw shell executes only when full-control gate and lease are active', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-shell-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { config, lease } = configured(root);
  const shell = new FullControlAdapter(new PolicyEngine(config, lease, 'test-client'));
  const command = os.platform() === 'win32'
    ? "[Console]::Out.Write('rwmcp-ok')"
    : "printf 'rwmcp-ok'";
  const result = await shell.shell(command, root, os.platform() === 'win32' ? 20000 : 3000);
  assert.equal(result.ok, true, result.stderr || `shell failed or timed out: ${JSON.stringify(result)}`);
  assert.equal(result.stdout, 'rwmcp-ok');
});
