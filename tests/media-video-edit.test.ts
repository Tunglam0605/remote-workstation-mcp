import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EngineeringResourceManager } from '../src/adapters/engineering/resource-manager.js';
import { MediaVideoEditAdapter, type MediaVideoEditRecipe } from '../src/extensions/media/video-edit.js';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-video-edit-'));
  const project = path.join(root, 'project');
  const exportsDir = path.join(project, 'exports');
  await fs.mkdir(exportsDir, { recursive: true });
  await fs.writeFile(path.join(project, 'a.mp4'), 'SOURCE-A');
  await fs.writeFile(path.join(project, 'b.mp4'), 'SOURCE-B');
  const font = path.join(root, 'font.ttf');
  await fs.writeFile(font, 'FONT');

  const paths = {
    resolveExisting: async (_workspace: string, relative: string) => {
      if (relative !== '.') throw new Error(`unexpected projectPath ${relative}`);
      return project;
    },
    resolveForWrite: async (_workspace: string, relative: string) => path.join(project, relative)
  };

  const probeCalls: string[] = [];
  const media = {
    probeFile: async (_workspace: string, _projectPath: string, input: string) => {
      probeCalls.push(input);
      if (input === 'exports/final.mp4') {
        return {
          input,
          backend: 'ffprobe',
          durationMs: 1,
          format: { durationSeconds: 3, sizeBytes: 100 },
          streams: [{ codecType: 'video', codecName: 'h264', width: 1080, height: 1920, avgFps: 30 }]
        };
      }
      return {
        input,
        backend: 'ffprobe',
        durationMs: 1,
        format: { durationSeconds: 5, sizeBytes: 8 },
        streams: [
          { codecType: 'video', codecName: 'h264', width: 720, height: 1280, avgFps: 30 },
          { codecType: 'audio', codecName: 'aac' }
        ]
      };
    }
  };

  const runCalls: Array<{ program: string; args: string[]; cwd: string }> = [];
  const runner = {
    run: async (program: string, args: string[], cwd: string) => {
      runCalls.push({ program, args: [...args], cwd });
      await fs.writeFile(args.at(-1)!, 'RENDERED');
      return { program, args, cwd, exitCode: 0, stdout: '', stderr: '', timedOut: false, durationMs: 5 };
    }
  };

  const adapter = new MediaVideoEditAdapter(
    paths as never,
    runner as never,
    new EngineeringResourceManager('owner'),
    media as never,
    {
      rendererOptions: {
        resolveFfmpeg: async () => 'C:/Tools/ffmpeg.exe',
        fontFile: font,
        tempRoot: root
      }
    }
  );

  return { root, project, adapter, probeCalls, runCalls };
}

function recipe(): MediaVideoEditRecipe {
  return {
    canvas: 'vertical-1080x1920',
    fps: 30,
    clips: [
      {
        input: 'a.mp4',
        sourceStartMs: 500,
        sourceDurationMs: 2000,
        speed: 1,
        volume: 0.8,
        scale: 1.1
      },
      {
        input: 'a.mp4',
        sourceStartMs: 3000,
        sourceDurationMs: 1000,
        speed: 1,
        opacity: 0.7,
        flipHorizontal: true
      }
    ],
    captions: [
      { text: 'Hook: CAN Bus', startMs: 250, durationMs: 1200 }
    ]
  };
}

test('typed video edit plan binds source SHA, redacts caption text and is deterministic', async () => {
  const f = await fixture();
  try {
    const first = await f.adapter.plan('w', '.', recipe(), 'exports/final.mp4');
    const second = await f.adapter.plan('w', '.', recipe(), 'exports/final.mp4');
    assert.equal(first.ready, true);
    assert.equal(first.planSha256, second.planSha256);
    assert.equal(first.backend, 'typed-video-edit-v1');
    assert.deepEqual(first.canvas, { width: 1080, height: 1920 });
    assert.equal(first.durationMs, 3000);
    assert.equal(first.clips.length, 2);
    assert.equal(first.clips[0]?.targetStartMs, 0);
    assert.equal(first.clips[1]?.targetStartMs, 2000);
    assert.equal(first.sources.length, 1);
    assert.equal(first.sources[0]?.input, 'a.mp4');
    assert.match(first.sources[0]?.sha256 ?? '', /^[a-f0-9]{64}$/);
    assert.equal(first.captions[0]?.textLength, 'Hook: CAN Bus'.length);
    assert.equal(JSON.stringify(first).includes('Hook: CAN Bus'), false);
    assert.equal(f.probeCalls.filter(item => item === 'a.mp4').length, 2);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('typed video edit supports whole-input duration derivation and source canvas', async () => {
  const f = await fixture();
  try {
    const plan = await f.adapter.plan('w', '.', {
      canvas: 'source',
      clips: [{ input: 'b.mp4', sourceStartMs: 1000 }],
      captions: []
    }, 'exports/final.mp4');
    assert.equal(plan.ready, true);
    assert.deepEqual(plan.canvas, { width: 720, height: 1280 });
    assert.equal(plan.durationMs, 4000);
    assert.equal(plan.clips[0]?.sourceDurationMs, 4000);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('typed video edit rejects source ranges outside probed media duration', async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      () => f.adapter.plan('w', '.', {
        clips: [{ input: 'a.mp4', sourceStartMs: 4500, sourceDurationMs: 1000 }]
      }, 'exports/final.mp4'),
      /exceeds input duration/i
    );
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('typed video edit re-hashes source and rejects stale plan before ffmpeg execution', async () => {
  const f = await fixture();
  try {
    const input = recipe();
    const plan = await f.adapter.plan('w', '.', input, 'exports/final.mp4');
    await fs.writeFile(path.join(f.project, 'a.mp4'), 'SOURCE-A-CHANGED');
    await assert.rejects(
      () => f.adapter.render('w', '.', input, 'exports/final.mp4', plan.planSha256, 10_000),
      /plan changed since review/i
    );
    assert.equal(f.runCalls.length, 0);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('typed video edit renders through the fixed graph and returns acceptance evidence', async () => {
  const f = await fixture();
  try {
    const input = recipe();
    const plan = await f.adapter.plan('w', '.', input, 'exports/final.mp4');
    const result = await f.adapter.render('w', '.', input, 'exports/final.mp4', plan.planSha256, 10_000);
    assert.equal(result.provider, 'typed-video-edit-v1');
    assert.equal(result.acceptance.planSha256Matched, true);
    assert.equal(result.acceptance.ffprobeAccepted, true);
    assert.equal(result.acceptance.sha256Computed, true);
    assert.equal(f.runCalls.length, 1);
    const call = f.runCalls[0]!;
    assert.equal(call.program, 'C:/Tools/ffmpeg.exe');
    const graph = call.args[call.args.indexOf('-filter_complex') + 1]!;
    assert.match(graph, /concat=n=2:v=1:a=1/);
    assert.match(graph, /drawtext=/);
    assert.match(graph, /hflip/);
    assert.match(graph, /colorchannelmixer=aa=0\.7/);
    assert.equal(graph.includes('Hook: CAN Bus'), false);
    const bytes = await fs.readFile(path.join(f.project, 'exports', 'final.mp4'));
    assert.equal(result.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});
