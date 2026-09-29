import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RemotionRenderAdapter } from '../src/extensions/media/remotion-render.js';
import { RemotionPresetStore, resolveRemotionParameters } from '../src/extensions/media/remotion-store.js';

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

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-remotion-'));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(path.join(root, 'out'), { recursive: true });
  await fs.mkdir(path.join(root, 'node_modules', '.bin'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'index.ts'), 'export {};');
  const cli = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'remotion.cmd' : 'remotion');
  const browser = path.join(root, process.platform === 'win32' ? 'chrome.exe' : 'chromium');
  await fs.writeFile(cli, 'fixture');
  await fs.writeFile(browser, 'fixture');
  const manifest = path.join(root, 'remotion-presets.json');
  await fs.writeFile(manifest, JSON.stringify({
    version: 1,
    presets: [{
      id: 'lesson',
      label: 'Lesson',
      entryPoint: 'src/index.ts',
      compositionId: 'LessonVertical',
      crf: 20,
      concurrency: 2,
      x264Preset: 'medium',
      bindings: {
        title: { type: 'string', required: true, maxLength: 200 },
        lesson: { type: 'number', default: 1, min: 1, max: 100 },
        captions: { type: 'boolean', default: true }
      }
    }]
  }));
  return { root, cli, browser, store: new RemotionPresetStore(manifest) };
}

test('Remotion preset store exposes only bounded public metadata and validates typed props', async () => {
  const fx = await fixture();
  try {
    const presets = await fx.store.list();
    assert.equal(presets.length, 1);
    const publicPreset = fx.store.publicPreset(presets[0]!);
    assert.equal(publicPreset.id, 'lesson');
    assert.equal(publicPreset.compositionId, 'LessonVertical');
    assert.doesNotMatch(JSON.stringify(publicPreset), /entryPoint|src[\\/]index/);

    assert.deepEqual(resolveRemotionParameters(presets[0]!, { title: 'CANopen' }), {
      title: 'CANopen',
      lesson: 1,
      captions: true
    });
    assert.throws(() => resolveRemotionParameters(presets[0]!, { unknown: 'x' }), /not exposed/i);
    assert.throws(() => resolveRemotionParameters(presets[0]!, { title: 42 }), /must be a string/i);
    assert.throws(() => resolveRemotionParameters(presets[0]!, { title: 'ok', lesson: 101 }), /exceeds max/i);
  } finally {
    await fs.rm(fx.root, { recursive: true, force: true });
  }
});

test('Remotion render plan requires project-local CLI, local browser and a contained fail-if-exists MP4', async () => {
  const fx = await fixture();
  const prior = process.env.RWMCP_REMOTION_BROWSER_EXECUTABLE;
  process.env.RWMCP_REMOTION_BROWSER_EXECUTABLE = fx.browser;
  try {
    const adapter = new RemotionRenderAdapter(
      fakePaths(fx.root),
      { run: async () => { throw new Error('plan must not execute'); } } as any,
      fx.store
    );
    const plan = await adapter.plan('ws', '.', 'lesson', { title: 'STM32' }, 'out/lesson.mp4');
    assert.equal(plan.localRemotionAvailable, true);
    assert.equal(plan.browserAvailable, true);
    assert.equal(plan.overwritePolicy, 'fail-if-exists');
    assert.deepEqual(plan.resolvedParameterKeys, ['captions', 'lesson', 'title']);
    assert.equal(plan.entryPoint.replaceAll('\\', '/'), 'src/index.ts');

    await assert.rejects(() => adapter.plan('ws', '.', 'lesson', { title: 'x' }, '../escape.mp4'), /cannot escape|project-relative/i);
    await assert.rejects(() => adapter.plan('ws', '.', 'lesson', { title: 'x' }, 'out/lesson.mkv'), /\.mp4/i);
  } finally {
    if (prior === undefined) delete process.env.RWMCP_REMOTION_BROWSER_EXECUTABLE;
    else process.env.RWMCP_REMOTION_BROWSER_EXECUTABLE = prior;
    await fs.rm(fx.root, { recursive: true, force: true });
  }
});

test('Remotion render uses fixed bounded CLI arguments, cleans temp props and returns SHA-256 evidence', async () => {
  const fx = await fixture();
  const prior = process.env.RWMCP_REMOTION_BROWSER_EXECUTABLE;
  process.env.RWMCP_REMOTION_BROWSER_EXECUTABLE = fx.browser;
  let propsFile = '';
  try {
    const runner = {
      async run(program: string, args: string[], cwd: string) {
        assert.equal(program, await fs.realpath(fx.cli));
        assert.equal(cwd, await fs.realpath(fx.root));
        assert.equal(args[0], 'render');
        assert.equal(args[2], 'LessonVertical');
        assert.ok(args.includes('--codec=h264'));
        assert.ok(args.includes('--overwrite=false'));
        assert.ok(args.includes('--x264-preset=medium'));
        assert.ok(args.includes('--concurrency=2'));
        assert.ok(args.includes(`--browser-executable=${fx.browser}`));
        const propsIndex = args.indexOf('--props');
        assert.ok(propsIndex >= 0);
        propsFile = args[propsIndex + 1]!;
        const relative = path.relative(fx.root, propsFile);
        assert.ok(relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative), 'props must stay outside project');
        const props = JSON.parse(await fs.readFile(propsFile, 'utf8'));
        assert.deepEqual(props, { title: 'ROS2', lesson: 2, captions: true });
        await fs.writeFile(args[3]!, 'rendered-video');
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, durationMs: 7 };
      }
    } as any;
    const adapter = new RemotionRenderAdapter(fakePaths(fx.root), runner, fx.store);
    const out = await adapter.render('ws', '.', 'lesson', { title: 'ROS2', lesson: 2 }, 'out/lesson.mp4', 5_000);
    assert.equal(out.backend, 'project-local-remotion');
    assert.equal(out.bytes, Buffer.byteLength('rendered-video'));
    assert.equal(out.sha256, crypto.createHash('sha256').update('rendered-video').digest('hex'));
    await assert.rejects(() => fs.stat(propsFile), /ENOENT/);
  } finally {
    if (prior === undefined) delete process.env.RWMCP_REMOTION_BROWSER_EXECUTABLE;
    else process.env.RWMCP_REMOTION_BROWSER_EXECUTABLE = prior;
    await fs.rm(fx.root, { recursive: true, force: true });
  }
});

test('Remotion render removes partial output on failure and never overwrites an existing artifact', async () => {
  const fx = await fixture();
  const prior = process.env.RWMCP_REMOTION_BROWSER_EXECUTABLE;
  process.env.RWMCP_REMOTION_BROWSER_EXECUTABLE = fx.browser;
  try {
    const runner = {
      async run(_program: string, args: string[]) {
        await fs.writeFile(args[3]!, 'partial');
        return { exitCode: 1, stdout: '', stderr: 'fixture failure', timedOut: false, durationMs: 2 };
      }
    } as any;
    const adapter = new RemotionRenderAdapter(fakePaths(fx.root), runner, fx.store);
    await assert.rejects(
      () => adapter.render('ws', '.', 'lesson', { title: 'fail' }, 'out/fail.mp4', 5_000),
      /render failed/i
    );
    await assert.rejects(() => fs.stat(path.join(fx.root, 'out', 'fail.mp4')), /ENOENT/);

    await fs.writeFile(path.join(fx.root, 'out', 'existing.mp4'), 'existing');
    await assert.rejects(
      () => adapter.render('ws', '.', 'lesson', { title: 'x' }, 'out/existing.mp4', 5_000),
      /already exists/i
    );
    assert.equal(await fs.readFile(path.join(fx.root, 'out', 'existing.mp4'), 'utf8'), 'existing');
  } finally {
    if (prior === undefined) delete process.env.RWMCP_REMOTION_BROWSER_EXECUTABLE;
    else process.env.RWMCP_REMOTION_BROWSER_EXECUTABLE = prior;
    await fs.rm(fx.root, { recursive: true, force: true });
  }
});
