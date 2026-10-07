import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EngineeringResourceManager } from '../src/adapters/engineering/resource-manager.js';
import { CapCutHeadlessRenderAdapter } from '../src/extensions/media/capcut-headless-render.js';

async function fixture(options: { blockers?: string[]; warnings?: string[]; withText?: boolean } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-capcut-headless-'));
  const projectRoot = path.join(root, 'project');
  const outputDir = path.join(projectRoot, 'exports');
  const source = path.join(projectRoot, 'source.mp4');
  const font = path.join(root, 'font.ttf');
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(source, 'SOURCE');
  await fs.writeFile(font, 'FONT');

  const model = {
    projectId: '1007',
    sha256: 'a'.repeat(64),
    mirrorConsistent: true,
    durationMs: 3000,
    fps: 30,
    canvas: { width: 1080, height: 1920 },
    videos: [
      {
        id: 'V1',
        sourcePath: source,
        sourceStartMs: 1000,
        sourceDurationMs: 2000,
        targetStartMs: 0,
        targetDurationMs: 2000,
        speed: 1,
        volume: 0.8,
        opacity: 1,
        scale: 1.1,
        rotationDeg: 0,
        x: 0,
        y: 0,
        flipHorizontal: false,
        flipVertical: false,
        hasAudio: true,
        width: 720,
        height: 1280
      },
      {
        id: 'V2',
        sourcePath: source,
        sourceStartMs: 4000,
        sourceDurationMs: 1000,
        targetStartMs: 2000,
        targetDurationMs: 1000,
        speed: 1,
        volume: 1,
        opacity: 0.75,
        scale: 1,
        rotationDeg: 0,
        x: 0,
        y: 0,
        flipHorizontal: true,
        flipVertical: false,
        hasAudio: false,
        width: 720,
        height: 1280
      }
    ],
    texts: options.withText === false ? [] : [
      { id: 'T1', text: 'CAN Bus cơ bản', targetStartMs: 500, targetDurationMs: 1200 }
    ],
    blockers: options.blockers ?? [],
    warnings: options.warnings ?? ['headless-text-style-is-generic-caption']
  };

  const drafts = {
    headlessRenderModel: async () => JSON.parse(JSON.stringify(model))
  };

  const paths = {
    resolveExisting: async (_workspace: string, relative: string) => {
      assert.equal(relative, '.');
      return projectRoot;
    },
    resolveForWrite: async (_workspace: string, relative: string) => path.join(projectRoot, relative)
  };

  const calls: Array<{ program: string; args: string[]; cwd: string; timeoutMs?: number }> = [];
  const runner = {
    run: async (program: string, args: string[], cwd: string, timeoutMs?: number) => {
      calls.push({ program, args: [...args], cwd, timeoutMs });
      const output = args.at(-1)!;
      await fs.writeFile(output, Buffer.from('RWMCP_HEADLESS_RENDER_ACCEPTANCE'));
      return { program, args, cwd, exitCode: 0, stdout: '', stderr: '', timedOut: false, durationMs: 12 };
    }
  };

  const media = {
    probeFile: async (_workspace: string, _projectPath: string, output: string) => {
      assert.equal(output, 'exports/final.mp4');
      return {
        input: output,
        backend: 'ffprobe',
        durationMs: 3,
        format: { name: 'mov,mp4', durationSeconds: 3, sizeBytes: 32, bitRate: 1000 },
        streams: [{ codecType: 'video', codecName: 'h264', width: 1080, height: 1920, avgFps: 30 }]
      };
    }
  };

  const adapter = new CapCutHeadlessRenderAdapter(
    paths as never,
    runner as never,
    new EngineeringResourceManager('owner'),
    drafts as never,
    media as never,
    {
      resolveFfmpeg: async () => 'C:/Tools/ffmpeg.exe',
      fontFile: font,
      tempRoot: root
    }
  );

  return { root, projectRoot, outputDir, source, font, model, adapter, calls };
}

test('headless CapCut plan is deterministic, bounded and redacts source paths/text', async () => {
  const f = await fixture();
  try {
    const a = await f.adapter.plan('w', '.', '1007', 'exports/final.mp4');
    const b = await f.adapter.plan('w', '.', '1007', 'exports/final.mp4');
    assert.equal(a.ready, true);
    assert.equal(a.planSha256, b.planSha256);
    assert.equal(a.backend, 'ffmpeg-capcut-subset-v1');
    assert.equal(a.fidelity, 'supported-subset-not-pixel-identical-to-capcut');
    assert.equal(a.draft.videoSegments.length, 2);
    assert.equal(a.draft.videoSegments[0]?.sourceName, 'source.mp4');
    assert.match(a.draft.textSegments[0]?.textSha256 ?? '', /^[a-f0-9]{64}$/);
    assert.equal(a.draft.textSegments[0]?.textLength, 'CAN Bus cơ bản'.length);
    const serialized = JSON.stringify(a);
    assert.equal(serialized.includes(f.source), false);
    assert.equal(serialized.includes('CAN Bus cơ bản'), false);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('headless CapCut plan fails closed on unsupported draft state', async () => {
  const f = await fixture({ blockers: ['video:V1:advanced-timeline-state'] });
  try {
    const plan = await f.adapter.plan('w', '.', '1007', 'exports/final.mp4');
    assert.equal(plan.ready, false);
    assert.ok(plan.blockers.includes('video:V1:advanced-timeline-state'));
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('headless CapCut render requires exact plan SHA and never invokes ffmpeg on conflict', async () => {
  const f = await fixture();
  try {
    const plan = await f.adapter.plan('w', '.', '1007', 'exports/final.mp4');
    const wrong = plan.planSha256 === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
    await assert.rejects(
      () => f.adapter.render('w', '.', '1007', 'exports/final.mp4', wrong, 10_000),
      /plan changed since review/i
    );
    assert.equal(f.calls.length, 0);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('headless CapCut render builds fixed ffmpeg graph, uses textfile and returns acceptance evidence', async () => {
  const f = await fixture();
  try {
    const plan = await f.adapter.plan('w', '.', '1007', 'exports/final.mp4');
    const result = await f.adapter.render('w', '.', '1007', 'exports/final.mp4', plan.planSha256, 10_000);
    assert.equal(result.output, 'exports/final.mp4');
    assert.equal(result.acceptance.planSha256Matched, true);
    assert.equal(result.acceptance.draftSha256Matched, true);
    assert.equal(result.acceptance.ffmpegExitedZero, true);
    assert.equal(result.acceptance.ffprobeAccepted, true);
    assert.equal(result.acceptance.durationAccepted, true);
    assert.equal(result.acceptance.sha256Computed, true);

    const bytes = await fs.readFile(path.join(f.outputDir, 'final.mp4'));
    assert.equal(result.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));

    assert.equal(f.calls.length, 1);
    const call = f.calls[0]!;
    assert.equal(call.program, 'C:/Tools/ffmpeg.exe');
    assert.equal(call.cwd, await fs.realpath(f.projectRoot));
    assert.ok(call.args.includes('-filter_complex'));
    const filterGraph = call.args[call.args.indexOf('-filter_complex') + 1]!;
    assert.match(filterGraph, /concat=n=2:v=1:a=1/);
    assert.match(filterGraph, /drawtext=/);
    assert.match(filterGraph, /textfile=/);
    assert.match(filterGraph, /atempo=1/);
    assert.match(filterGraph, /volume=0\.8/);
    assert.match(filterGraph, /hflip/);
    assert.match(filterGraph, /colorchannelmixer=aa=0\.75/);
    assert.equal(filterGraph.includes('CAN Bus cơ bản'), false);
    assert.equal(call.args.some(item => item === '-y'), false);

    await assert.rejects(
      () => f.adapter.plan('w', '.', '1007', 'exports/final.mp4'),
      /already exists/i
    );
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('headless CapCut render removes partial output when ffmpeg fails', async () => {
  const f = await fixture({ withText: false });
  try {
    const bad = new CapCutHeadlessRenderAdapter(
      {
        resolveExisting: async () => f.projectRoot,
        resolveForWrite: async (_w: string, relative: string) => path.join(f.projectRoot, relative)
      } as never,
      {
        run: async (_program: string, args: string[], cwd: string) => {
          await fs.writeFile(args.at(-1)!, 'PARTIAL');
          return { program: 'ffmpeg', args, cwd, exitCode: 1, stdout: '', stderr: 'failed', timedOut: false, durationMs: 1 };
        }
      } as never,
      new EngineeringResourceManager('owner'),
      { headlessRenderModel: async () => JSON.parse(JSON.stringify(f.model)) } as never,
      {} as never,
      { resolveFfmpeg: async () => 'ffmpeg.exe', tempRoot: f.root }
    );
    const plan = await bad.plan('w', '.', '1007', 'exports/final.mp4');
    await assert.rejects(
      () => bad.render('w', '.', '1007', 'exports/final.mp4', plan.planSha256, 10_000),
      /FFmpeg failed/i
    );
    await assert.rejects(() => fs.stat(path.join(f.outputDir, 'final.mp4')), /ENOENT/);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});
