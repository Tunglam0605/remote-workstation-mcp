import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MediaVideoAdapter } from '../src/extensions/media/media-adapter.js';
import { MediaProfileStore } from '../src/extensions/media/profile-store.js';

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

test('media profile store loads bounded non-secret ComfyUI endpoints', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-media-'));
  const file = path.join(root, 'media-profiles.json');
  await fs.writeFile(file, JSON.stringify({
    version: 1,
    profiles: [{ id: 'gpu', kind: 'comfyui', host: '127.0.0.1', port: 8188, scheme: 'http' }]
  }));
  const store = new MediaProfileStore(file);
  const list = await store.list();
  assert.equal(list.length, 1);
  assert.deepEqual(await store.status(), { configured: true, profileCount: 1, byKind: { comfyui: 1 } });
  assert.doesNotMatch(JSON.stringify(list), /password|token|secret|apiKey/i);
  await fs.rm(root, { recursive: true, force: true });
});

test('media profile store rejects URL-like or userinfo hosts', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-media-'));
  const file = path.join(root, 'media-profiles.json');
  await fs.writeFile(file, JSON.stringify({
    version: 1,
    profiles: [{ id: 'bad', kind: 'comfyui', host: 'http://user@127.0.0.1', port: 8188 }]
  }));
  const store = new MediaProfileStore(file);
  await assert.rejects(() => store.list(), /hostname or IP address|invalid/i);
  await fs.rm(root, { recursive: true, force: true });
});

test('Remotion status inspects package metadata without executing npm', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-media-'));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
    dependencies: { remotion: '4.0.1', '@remotion/renderer': '4.0.1' },
    scripts: { 'render:video': 'remotion render', test: 'node test.js' }
  }));
  const adapter = new MediaVideoAdapter(fakePaths(root), { run: async () => { throw new Error('runner should not execute'); } } as any, new MediaProfileStore(path.join(root, 'missing.json')));
  const status = await adapter.remotionStatus('ws', '.');
  assert.equal(status.configured, true);
  assert.deepEqual(status.packages.map(item => item.name), ['remotion', '@remotion/renderer']);
  assert.deepEqual(status.scripts, ['render:video']);
  await fs.rm(root, { recursive: true, force: true });
});

test('failed media transcode removes partial output and never overwrites existing output', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-media-'));
  const input = path.join(root, 'input.mp4');
  const output = path.join(root, 'output.mp4');
  const fakeFfmpeg = path.join(root, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  await fs.writeFile(input, 'input');
  await fs.writeFile(fakeFfmpeg, 'fixture');

  const prior = process.env.RWMCP_FFMPEG_EXECUTABLE;
  process.env.RWMCP_FFMPEG_EXECUTABLE = fakeFfmpeg;
  try {
    const runner = {
      async run(_program: string, args: string[]) {
        const target = args.at(-1)!;
        await fs.writeFile(target, 'partial');
        return { exitCode: 1, stdout: '', stderr: 'fixture failure', timedOut: false, durationMs: 1 };
      }
    } as any;
    const adapter = new MediaVideoAdapter(fakePaths(root), runner, new MediaProfileStore(path.join(root, 'missing.json')));
    await assert.rejects(() => adapter.transcode('ws', '.', 'input.mp4', 'output.mp4', 'web-preview', 2_000), /ffmpeg failed/i);
    await assert.rejects(() => fs.stat(output), /ENOENT/);

    await fs.writeFile(output, 'existing');
    await assert.rejects(() => adapter.transcodePlan('ws', '.', 'input.mp4', 'output.mp4', 'web-preview'), /already exists/i);
    assert.equal(await fs.readFile(output, 'utf8'), 'existing');

    await assert.rejects(() => adapter.transcodePlan('ws', '.', 'input.mp4', 'output.mkv', 'web-preview'), /\.mp4/i);
  } finally {
    if (prior === undefined) delete process.env.RWMCP_FFMPEG_EXECUTABLE;
    else process.env.RWMCP_FFMPEG_EXECUTABLE = prior;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('ComfyUI status reads system and queue summaries without workflow submission', async () => {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url ?? '');
    res.setHeader('content-type', 'application/json');
    if (req.url === '/system_stats') {
      res.end(JSON.stringify({
        system: { os: 'posix', python_version: '3.12', pytorch_version: '2.x', comfyui_version: '1.x', argv: ['ignored'] },
        devices: [{ name: 'GPU', type: 'cuda', vram_total: 1000, vram_free: 500 }]
      }));
      return;
    }
    if (req.url === '/queue') {
      res.end(JSON.stringify({ queue_running: [[1]], queue_pending: [[2], [3]] }));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-media-'));
  const file = path.join(root, 'media-profiles.json');
  await fs.writeFile(file, JSON.stringify({
    version: 1,
    profiles: [{ id: 'gpu', kind: 'comfyui', host: '127.0.0.1', port: address.port, scheme: 'http' }]
  }));
  try {
    const adapter = new MediaVideoAdapter(fakePaths(root), {} as any, new MediaProfileStore(file));
    const status = await adapter.comfyUiStatus('gpu', 2_000);
    assert.equal(status.reachable, true);
    assert.equal(status.queue.running, 1);
    assert.equal(status.queue.pending, 2);
    assert.equal(status.devices[0]?.name, 'GPU');
    assert.deepEqual(requests.sort(), ['/queue', '/system_stats']);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
});
