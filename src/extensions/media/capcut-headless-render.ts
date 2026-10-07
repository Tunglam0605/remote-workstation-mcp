import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { EngineeringCommandRunner } from '../../adapters/engineering/command-runner.js';
import { resolveExecutable } from '../../adapters/engineering/executable-resolver.js';
import type { EngineeringResourceManager } from '../../adapters/engineering/resource-manager.js';
import type { PathGuard } from '../../security/path-guard.js';
import type {
  CapCutDraftAdapter,
  CapCutHeadlessRenderModel,
  CapCutHeadlessVideoSegment
} from './capcut-draft.js';
import type { MediaVideoAdapter } from './media-adapter.js';

interface HeadlessRenderOptions {
  resolveFfmpeg?: () => Promise<string | undefined>;
  fontFile?: string;
  tempRoot?: string;
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function sha256Text(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

async function sha256File(filename: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filename);
    stream.on('data', chunk => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  return hash.digest('hex');
}

function seconds(ms: number): string {
  return (ms / 1000).toFixed(6).replace(/0+$/, '').replace(/.$/, '');
}

function escapeFilterPath(filename: string): string {
  return filename.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

function atempoFilters(speed: number): string[] {
  if (!Number.isFinite(speed) || speed <= 0 || speed > 100) throw new Error('Unsupported headless audio speed.');
  const factors: number[] = [];
  let remaining = speed;
  while (remaining < 0.5 - 1e-9) {
    factors.push(0.5);
    remaining /= 0.5;
  }
  while (remaining > 100 + 1e-9) {
    factors.push(100);
    remaining /= 100;
  }
  factors.push(remaining);
  return factors.map(value => `atempo=${value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`);
}

async function defaultFfmpeg(): Promise<string | undefined> {
  const override = process.env.RWMCP_FFMPEG_EXECUTABLE?.trim();
  if (override) {
    if (!path.isAbsolute(override)) throw new Error('RWMCP_FFMPEG_EXECUTABLE must be absolute.');
    await fs.access(override);
    return override;
  }
  return await resolveExecutable('ffmpeg');
}

async function defaultFontFile(): Promise<string | undefined> {
  const override = process.env.RWMCP_VIDEO_FONT_FILE?.trim();
  if (override) {
    if (!path.isAbsolute(override)) throw new Error('RWMCP_VIDEO_FONT_FILE must be absolute.');
    return await fs.stat(override).then(stat => stat.isFile() ? override : undefined).catch(() => undefined);
  }
  const candidates = process.platform === 'win32'
    ? ['C:/Windows/Fonts/arial.ttf', 'C:/Windows/Fonts/segoeui.ttf']
    : process.platform === 'darwin'
      ? ['/System/Library/Fonts/Supplemental/Arial.ttf', '/System/Library/Fonts/Helvetica.ttc']
      : ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf'];
  for (const candidate of candidates) {
    if (await fs.stat(candidate).then(stat => stat.isFile()).catch(() => false)) return candidate;
  }
  return undefined;
}

function publicModel(model: CapCutHeadlessRenderModel) {
  return {
    projectId: model.projectId,
    draftSha256: model.sha256,
    durationMs: model.durationMs,
    fps: model.fps,
    canvas: model.canvas,
    videoSegments: model.videos.map(segment => ({
      id: segment.id,
      sourceName: path.basename(segment.sourcePath),
      sourceStartMs: segment.sourceStartMs,
      sourceDurationMs: segment.sourceDurationMs,
      targetStartMs: segment.targetStartMs,
      targetDurationMs: segment.targetDurationMs,
      speed: segment.speed,
      volume: segment.volume,
      opacity: segment.opacity,
      scale: segment.scale,
      rotationDeg: segment.rotationDeg,
      flipHorizontal: segment.flipHorizontal,
      flipVertical: segment.flipVertical,
      hasAudio: segment.hasAudio
    })),
    textSegments: model.texts.map(item => ({
      id: item.id,
      textSha256: sha256Text(item.text),
      textLength: item.text.length,
      targetStartMs: item.targetStartMs,
      targetDurationMs: item.targetDurationMs
    })),
    blockers: model.blockers,
    warnings: model.warnings
  };
}

function renderPlanDigest(value: Record<string, unknown>): string {
  return sha256Text(JSON.stringify(value));
}

function videoChain(
  segment: CapCutHeadlessVideoSegment,
  inputIndex: number,
  width: number,
  height: number,
  fps: number
): string[] {
  const labelBase = `v${inputIndex}base`;
  const chain: string[] = [
    `[${inputIndex}:v]setpts=(PTS-STARTPTS)/${segment.speed},scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,fps=${fps}`
  ];
  if (segment.flipHorizontal) chain[0] += ',hflip';
  if (segment.flipVertical) chain[0] += ',vflip';
  if (Math.abs(segment.scale - 1) > 1e-6) {
    if (segment.scale > 1) {
      chain[0] += `,scale=trunc(iw*${segment.scale}/2)*2:trunc(ih*${segment.scale}/2)*2,crop=${width}:${height}:(iw-${width})/2:(ih-${height})/2`;
    } else {
      chain[0] += `,scale=trunc(iw*${segment.scale}/2)*2:trunc(ih*${segment.scale}/2)*2,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`;
    }
  }
  if (Math.abs(segment.rotationDeg) > 1e-6) {
    chain[0] += `,rotate=${segment.rotationDeg}*PI/180:ow=${width}:oh=${height}:c=black`;
  }
  chain[0] += `[${labelBase}]`;
  if (segment.opacity < 1 - 1e-6) {
    const duration = seconds(segment.targetDurationMs);
    chain.push(`color=c=black:s=${width}x${height}:d=${duration}[v${inputIndex}bg]`);
    chain.push(`[${labelBase}]format=rgba,colorchannelmixer=aa=${segment.opacity}[v${inputIndex}fg]`);
    chain.push(`[v${inputIndex}bg][v${inputIndex}fg]overlay=shortest=1,format=yuv420p[v${inputIndex}]`);
  } else {
    chain.push(`[${labelBase}]format=yuv420p[v${inputIndex}]`);
  }
  return chain;
}

function audioChain(segment: CapCutHeadlessVideoSegment, inputIndex: number): string {
  if (!segment.hasAudio || segment.volume <= 0) {
    return `anullsrc=r=48000:cl=stereo,atrim=duration=${seconds(segment.targetDurationMs)}[a${inputIndex}]`;
  }
  const filters = ['asetpts=PTS-STARTPTS', ...atempoFilters(segment.speed)];
  if (Math.abs(segment.volume - 1) > 1e-6) filters.push(`volume=${segment.volume}`);
  filters.push('aresample=48000');
  return `[${inputIndex}:a]${filters.join(',')}[a${inputIndex}]`;
}

export class CapCutHeadlessRenderAdapter {
  private readonly resolveFfmpeg: () => Promise<string | undefined>;
  private readonly fontFileOverride?: string;
  private readonly tempRoot?: string;

  constructor(
    private readonly paths: PathGuard,
    private readonly runner: EngineeringCommandRunner,
    private readonly resources: EngineeringResourceManager,
    private readonly drafts: CapCutDraftAdapter,
    private readonly media: MediaVideoAdapter,
    options: HeadlessRenderOptions = {}
  ) {
    this.resolveFfmpeg = options.resolveFfmpeg ?? defaultFfmpeg;
    this.fontFileOverride = options.fontFile;
    this.tempRoot = options.tempRoot;
  }

  private async resolveOutput(workspace: string, projectPath: string, output: string) {
    if (!output || output.length > 1024 || output.includes('\0')) throw new Error('CapCut headless output is invalid.');
    if (path.isAbsolute(output)) throw new Error('CapCut headless output must be relative to the selected project.');
    if (path.extname(output).toLowerCase() !== '.mp4') throw new Error('CapCut headless output must use .mp4.');
    const projectRoot = await this.paths.resolveExisting(workspace, projectPath);
    const projectRootReal = await fs.realpath(projectRoot);
    const outputAbsolute = await this.paths.resolveForWrite(workspace, path.join(projectPath, output));
    const parentReal = await fs.realpath(path.dirname(outputAbsolute));
    if (!inside(projectRootReal, parentReal)) throw new Error('CapCut headless output parent escapes the selected project.');
    const existing = await fs.lstat(outputAbsolute).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    if (existing) throw new Error('CapCut headless output already exists; render never overwrites.');
    return { projectRoot: projectRootReal, outputAbsolute };
  }

  private async fontFile(model: CapCutHeadlessRenderModel): Promise<string | undefined> {
    if (!model.texts.length) return undefined;
    if (this.fontFileOverride) {
      if (!path.isAbsolute(this.fontFileOverride)) throw new Error('Headless fontFile override must be absolute.');
      return await fs.stat(this.fontFileOverride).then(stat => stat.isFile() ? this.fontFileOverride : undefined).catch(() => undefined);
    }
    return await defaultFontFile();
  }

  async plan(workspace: string, projectPath: string, capcutProjectId: string, output: string) {
    await this.resolveOutput(workspace, projectPath, output);
    const model = await this.drafts.headlessRenderModel(capcutProjectId);
    const blockers = [...model.blockers];
    const ffmpeg = await this.resolveFfmpeg().catch(() => undefined);
    if (!ffmpeg) blockers.push('ffmpeg-unavailable');
    const fontFile = await this.fontFile(model);
    if (model.texts.length && !fontFile) blockers.push('caption-font-unavailable');
    const publicDraft = publicModel(model);
    const payload = {
      workspace,
      projectPath,
      capcutProjectId: model.projectId,
      output,
      draft: publicDraft,
      backend: 'ffmpeg-capcut-subset-v1',
      captionStyle: model.texts.length ? 'generic-lower-third-white-with-border' : 'none'
    };
    return {
      ready: blockers.length === 0,
      blockers: [...new Set(blockers)],
      warnings: model.warnings,
      workspace,
      projectPath,
      capcutProjectId: model.projectId,
      output,
      backend: 'ffmpeg-capcut-subset-v1',
      fidelity: 'supported-subset-not-pixel-identical-to-capcut',
      draft: publicDraft,
      planSha256: renderPlanDigest(payload)
    };
  }

  async render(
    workspace: string,
    projectPath: string,
    capcutProjectId: string,
    output: string,
    expectedPlanSha256: string,
    timeoutMs = 600_000
  ) {
    if (!/^[a-f0-9]{64}$/i.test(expectedPlanSha256)) throw new Error('expectedPlanSha256 must be a SHA-256 digest.');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 900_000) {
      throw new Error('CapCut headless render timeoutMs must be 10000..900000.');
    }
    const resourceId = `capcut-headless-render:${capcutProjectId}`;
    return await this.resources.withLease(resourceId, 'orchestrating', async () => {
      const plan = await this.plan(workspace, projectPath, capcutProjectId, output);
      if (plan.planSha256 !== expectedPlanSha256.toLowerCase()) throw new Error('CONFLICT: CapCut headless render plan changed since review.');
      if (!plan.ready) throw new Error(`CAPCUT_HEADLESS_NOT_READY: ${plan.blockers.join(', ')}`);

      const model = await this.drafts.headlessRenderModel(capcutProjectId);
      if (model.sha256 !== plan.draft.draftSha256) throw new Error('CONFLICT: CapCut draft changed after render planning.');
      const { projectRoot, outputAbsolute } = await this.resolveOutput(workspace, projectPath, output);
      const executable = await this.resolveFfmpeg();
      if (!executable) throw new Error('ffmpeg is unavailable.');
      const fontFile = await this.fontFile(model);
      const tempRoot = await fs.mkdtemp(path.join(this.tempRoot ?? os.tmpdir(), 'rwmcp-capcut-render-'));
      let accepted = false;
      try {
        const args: string[] = ['-hide_banner', '-loglevel', 'error', '-n'];
        for (const segment of model.videos) {
          args.push('-ss', seconds(segment.sourceStartMs), '-t', seconds(segment.sourceDurationMs), '-i', segment.sourcePath);
        }

        const filters: string[] = [];
        model.videos.forEach((segment, index) => {
          filters.push(...videoChain(segment, index, model.canvas.width, model.canvas.height, model.fps));
          filters.push(audioChain(segment, index));
        });
        const concatInputs = model.videos.map((_segment, index) => `[v${index}][a${index}]`).join('');
        filters.push(`${concatInputs}concat=n=${model.videos.length}:v=1:a=1[vbase][abase]`);

        let videoLabel = 'vbase';
        if (model.texts.length) {
          if (!fontFile) throw new Error('caption font is unavailable.');
          const escapedFont = escapeFilterPath(fontFile);
          const fontSize = Math.max(28, Math.round(model.canvas.height * 0.045));
          const border = Math.max(2, Math.round(fontSize * 0.08));
          for (let index = 0; index < model.texts.length; index += 1) {
            const text = model.texts[index]!;
            const textFile = path.join(tempRoot, `caption-${index}.txt`);
            await fs.writeFile(textFile, text.text, 'utf8');
            const next = index === model.texts.length - 1 ? 'vout' : `vtext${index}`;
            filters.push(
              `[${videoLabel}]drawtext=fontfile='${escapedFont}':textfile='${escapeFilterPath(textFile)}':` +
              `fontcolor=white:fontsize=${fontSize}:borderw=${border}:bordercolor=black@0.85:` +
              `x=(w-text_w)/2:y=h-text_h-h*0.08:enable='between(t,${seconds(text.targetStartMs)},${seconds(text.targetStartMs + text.targetDurationMs)})'[${next}]`
            );
            videoLabel = next;
          }
        } else {
          filters.push('[vbase]null[vout]');
          videoLabel = 'vout';
        }
        if (videoLabel !== 'vout') filters.push(`[${videoLabel}]null[vout]`);

        args.push(
          '-filter_complex', filters.join(';'),
          '-map', '[vout]',
          '-map', '[abase]',
          '-r', String(model.fps),
          '-c:v', 'libx264',
          '-preset', 'medium',
          '-crf', '20',
          '-pix_fmt', 'yuv420p',
          '-c:a', 'aac',
          '-b:a', '192k',
          '-movflags', '+faststart',
          outputAbsolute
        );

        const result = await this.runner.run(executable, args, projectRoot, timeoutMs);
        if (result.timedOut) throw new Error('CapCut headless FFmpeg render timed out.');
        if (result.exitCode !== 0) throw new Error(`CapCut headless FFmpeg failed with exit code ${result.exitCode ?? 'null'}: ${result.stderr.slice(-1024)}`);
        const stat = await fs.stat(outputAbsolute);
        if (!stat.isFile() || stat.size <= 0) throw new Error('Headless renderer returned success without a non-empty MP4.');
        const probe = await this.media.probeFile(workspace, projectPath, output, 10_000);
        const video = probe.streams.find((stream: { codecType?: string }) => stream.codecType === 'video');
        const durationSeconds = probe.format.durationSeconds;
        if (!video || typeof durationSeconds !== 'number' || durationSeconds <= 0) throw new Error('Headless MP4 failed FFprobe video acceptance.');
        const expectedSeconds = model.durationMs / 1000;
        if (Math.abs(durationSeconds - expectedSeconds) > Math.max(0.5, expectedSeconds * 0.03)) {
          throw new Error(`Headless MP4 duration ${durationSeconds}s differs from planned ${expectedSeconds}s.`);
        }
        const sha256 = await sha256File(outputAbsolute);
        accepted = true;
        return {
          provider: 'ffmpeg-capcut-subset-v1',
          fidelity: 'supported-subset-not-pixel-identical-to-capcut',
          capcutProjectId: model.projectId,
          draftSha256: model.sha256,
          output,
          bytes: stat.size,
          sha256,
          warnings: model.warnings,
          probe,
          acceptance: {
            planSha256Matched: true,
            draftSha256Matched: true,
            outputWasAbsentBeforeRun: true,
            ffmpegExitedZero: true,
            ffprobeAccepted: true,
            durationAccepted: true,
            sha256Computed: true
          }
        };
      } finally {
        await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
        if (!accepted) await fs.rm(outputAbsolute, { force: true }).catch(() => undefined);
      }
    });
  }
}
