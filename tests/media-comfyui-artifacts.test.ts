import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ComfyUiArtifactImporter } from '../src/extensions/media/comfyui-artifacts.js';
import { ComfyUiPresetJobs } from '../src/extensions/media/comfyui-jobs.js';
import { MediaProfileStore } from '../src/extensions/media/profile-store.js';
import { ComfyUiPresetStore } from '../src/extensions/media/workflow-store.js';

function fakePaths(root: string) {
  return {
    async resolveExisting(_workspace: string, relative = '.') {
      return await fs.realpath(path.resolve(root, relative));
    },
    async resolveForWrite(_workspace: string, relative: string) {
      return path.resolve(root, relative);
    }
  } as any;
}

async function profileFixture(port: number) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-comfy-artifact-'));
  const profileFile = path.join(root, 'media-profiles.json');
  await fs.writeFile(profileFile, JSON.stringify({
    version: 1,
    profiles: [{ id: 'gpu', kind: 'comfyui', host: '127.0.0.1', port, scheme: 'http' }]
  }));
  const profiles = new MediaProfileStore(profileFile);
  const presets = new ComfyUiPresetStore(path.join(root, 'missing-presets.json'), path.join(root, 'missing-workflows'));
  const jobs = new ComfyUiPresetJobs(profiles, presets);
  return { root, profiles, jobs };
}

function historyResponse(artifact: { filename: string; subfolder?: string; type: string }) {
  return {
    job_1: {
      status: { completed: true, status_str: 'success' },
      outputs: {
        '9': { images: [artifact] }
      }
    }
  };
}

test('ComfyUI artifact plan selects history artifact by index and keeps destination project-scoped', async () => {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/history/job_1') {
      res.end(JSON.stringify(historyResponse({ filename: 'frame.png', subfolder: 'run1', type: 'output' })));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const fx = await profileFixture(address.port);
  await fs.mkdir(path.join(fx.root, 'artifacts'));

  try {
    const importer = new ComfyUiArtifactImporter(fakePaths(fx.root), fx.profiles, fx.jobs);
    const plan = await importer.plan('gpu', 'job_1', 0, 'ws', '.', 'artifacts/frame.png', 2_000);
    assert.equal(plan.artifact.filename, 'frame.png');
    assert.equal(plan.artifact.subfolder, 'run1');
    assert.equal(plan.artifact.type, 'output');
    assert.equal(plan.destination, 'artifacts/frame.png');
    assert.equal(plan.overwritePolicy, 'fail-if-exists');
  } finally {
    await fs.rm(fx.root, { recursive: true, force: true });
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('ComfyUI artifact import streams durable output into project and returns SHA-256 evidence', async () => {
  const body = Buffer.from('fixture-image-bytes');
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url ?? '');
    if (req.url === '/history/job_1') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(historyResponse({ filename: 'frame.png', subfolder: 'run1', type: 'output' })));
      return;
    }
    if (req.url?.startsWith('/view?')) {
      const url = new URL(req.url, 'http://127.0.0.1');
      assert.equal(url.searchParams.get('filename'), 'frame.png');
      assert.equal(url.searchParams.get('subfolder'), 'run1');
      assert.equal(url.searchParams.get('type'), 'output');
      res.setHeader('content-type', 'image/png');
      res.setHeader('content-length', String(body.length));
      res.end(body);
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const fx = await profileFixture(address.port);
  await fs.mkdir(path.join(fx.root, 'artifacts'));

  try {
    const importer = new ComfyUiArtifactImporter(fakePaths(fx.root), fx.profiles, fx.jobs);
    const result = await importer.importArtifact(
      'gpu', 'job_1', 0, 'ws', '.', 'artifacts/frame.png',
      { timeoutMs: 2_000, maxBytes: 1024 }
    );
    assert.equal(result.bytes, body.length);
    assert.equal(result.sha256, crypto.createHash('sha256').update(body).digest('hex'));
    assert.equal(result.contentType, 'image/png');
    assert.deepEqual(await fs.readFile(path.join(fx.root, 'artifacts', 'frame.png')), body);
    assert.equal(requests.length, 2);
  } finally {
    await fs.rm(fx.root, { recursive: true, force: true });
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('ComfyUI artifact import never overwrites an existing project file', async () => {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(historyResponse({ filename: 'frame.png', type: 'output' })));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const fx = await profileFixture(address.port);
  await fs.mkdir(path.join(fx.root, 'artifacts'));
  const destination = path.join(fx.root, 'artifacts', 'frame.png');
  await fs.writeFile(destination, 'existing');

  try {
    const importer = new ComfyUiArtifactImporter(fakePaths(fx.root), fx.profiles, fx.jobs);
    await assert.rejects(
      () => importer.importArtifact('gpu', 'job_1', 0, 'ws', '.', 'artifacts/frame.png', { timeoutMs: 2_000 }),
      /already exists/i
    );
    assert.equal(await fs.readFile(destination, 'utf8'), 'existing');
  } finally {
    await fs.rm(fx.root, { recursive: true, force: true });
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('ComfyUI artifact importer rejects non-output and unsafe artifact metadata', async () => {
  let mode: 'temp' | 'unsafe' = 'temp';
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    const artifact = mode === 'temp'
      ? { filename: 'frame.png', type: 'temp' }
      : { filename: '../frame.png', type: 'output' };
    res.end(JSON.stringify(historyResponse(artifact)));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const fx = await profileFixture(address.port);
  await fs.mkdir(path.join(fx.root, 'artifacts'));

  try {
    const importer = new ComfyUiArtifactImporter(fakePaths(fx.root), fx.profiles, fx.jobs);
    await assert.rejects(
      () => importer.plan('gpu', 'job_1', 0, 'ws', '.', 'artifacts/frame.png', 2_000),
      /durable ComfyUI output/i
    );
    mode = 'unsafe';
    await assert.rejects(
      () => importer.plan('gpu', 'job_1', 0, 'ws', '.', 'artifacts/frame.png', 2_000),
      /filename is missing or unsafe/i
    );
  } finally {
    await fs.rm(fx.root, { recursive: true, force: true });
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('ComfyUI artifact import enforces declared maxBytes before creating final output', async () => {
  const body = Buffer.alloc(128, 7);
  const server = http.createServer((req, res) => {
    if (req.url === '/history/job_1') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(historyResponse({ filename: 'frame.png', type: 'output' })));
      return;
    }
    res.setHeader('content-type', 'image/png');
    res.setHeader('content-length', String(body.length));
    res.end(body);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const fx = await profileFixture(address.port);
  await fs.mkdir(path.join(fx.root, 'artifacts'));
  const destination = path.join(fx.root, 'artifacts', 'frame.png');

  try {
    const importer = new ComfyUiArtifactImporter(fakePaths(fx.root), fx.profiles, fx.jobs);
    await assert.rejects(
      () => importer.importArtifact('gpu', 'job_1', 0, 'ws', '.', 'artifacts/frame.png', { timeoutMs: 2_000, maxBytes: 32 }),
      /exceeds configured maxBytes/i
    );
    await assert.rejects(() => fs.stat(destination), /ENOENT/);
    const files = await fs.readdir(path.dirname(destination));
    assert.deepEqual(files, []);
  } finally {
    await fs.rm(fx.root, { recursive: true, force: true });
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
