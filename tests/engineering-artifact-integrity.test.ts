import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ArtifactIntegrityAdapter } from '../src/adapters/engineering/artifact-integrity.js';
import type { PolicyConfig } from '../src/model.js';
import { PolicyEngine } from '../src/policy.js';
import { PathGuard } from '../src/security/path-guard.js';

function config(root: string): PolicyConfig {
  return {
    version: 1,
    mode: 'workspace',
    workspaces: [{ id: 'w', root, readOnly: false }],
    filesystem: { maxReadBytes: 1024 * 1024, maxWriteBytes: 1024 * 1024 },
    process: { allowExecutables: [], inheritEnv: ['PATH'], maxOutputBytes: 262144, maxRuntimeMs: 600000 },
    engineering: { enabled: true, maxCommandRuntimeMs: 600000, allowHardwareMutationInWorkspace: true, allowSerialWriteInWorkspace: true }
  };
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-artifact-'));
  const project = path.join(root, 'project');
  await fs.mkdir(path.join(project, 'staging'), { recursive: true });
  const policy = new PolicyEngine(config(root));
  const adapter = new ArtifactIntegrityAdapter(policy, new PathGuard(policy));
  return { root, project, adapter };
}

test('artifact prepare emits canonical SHA-256 and size manifest', async () => {
  const f = await fixture();
  try {
    const body = ':020000040801F1\n:00000001FF\n';
    await fs.writeFile(path.join(f.project, 'firmware.hex'), body, 'utf8');
    const manifest = await f.adapter.prepare('w', 'project', 'firmware.hex');
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.artifact, 'firmware.hex');
    assert.equal(manifest.kind, 'hex');
    assert.equal(manifest.size, Buffer.byteLength(body));
    assert.equal(manifest.sha256, createHash('sha256').update(body).digest('hex'));
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('artifact accept fails closed on SHA mismatch without promoting output', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.project, 'staging', 'firmware.hex'), ':00000001FF\n', 'utf8');
    await assert.rejects(
      f.adapter.accept({
        workspace: 'w',
        projectPath: 'project',
        artifact: 'staging/firmware.hex',
        expectedSha256: '0'.repeat(64)
      }),
      /SHA-256 mismatch/
    );
    await assert.rejects(
      fs.access(path.join(f.project, '.rwmcp', 'artifacts', 'verified', `${'0'.repeat(64)}-firmware.hex`)),
      /ENOENT/
    );
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('artifact accept atomically promotes matching content and is idempotent', async () => {
  const f = await fixture();
  try {
    const body = ':020000040801F1\n:00000001FF\n';
    const source = path.join(f.project, 'staging', 'firmware.hex');
    await fs.writeFile(source, body, 'utf8');
    const expectedSha256 = createHash('sha256').update(body).digest('hex');
    const expectedSize = Buffer.byteLength(body);

    const first = await f.adapter.accept({
      workspace: 'w',
      projectPath: 'project',
      artifact: 'staging/firmware.hex',
      expectedSha256,
      expectedSize
    });
    assert.equal(first.reused, false);
    assert.equal(first.sha256, expectedSha256);
    assert.equal(first.size, expectedSize);

    const verified = await fs.readFile(path.join(f.project, ...first.verifiedPath.split('/')), 'utf8');
    assert.equal(verified, body);
    const manifest = JSON.parse(await fs.readFile(path.join(f.project, ...first.manifestPath.split('/')), 'utf8')) as Record<string, unknown>;
    assert.equal(manifest.sha256, expectedSha256);
    assert.equal(manifest.size, expectedSize);

    const second = await f.adapter.accept({
      workspace: 'w',
      projectPath: 'project',
      artifact: 'staging/firmware.hex',
      expectedSha256,
      expectedSize
    });
    assert.equal(second.reused, true);
    assert.equal(second.verifiedPath, first.verifiedPath);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});
