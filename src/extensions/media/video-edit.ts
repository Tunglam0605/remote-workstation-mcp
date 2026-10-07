import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { EngineeringCommandRunner } from '../../adapters/engineering/command-runner.js';
import { resolveExistingProjectPath } from '../../adapters/engineering/project-path.js';
import type { EngineeringResourceManager } from '../../adapters/engineering/resource-manager.js';
import type { PathGuard } from '../../security/path-guard.js';
import type { CapCutDraftAdapter, CapCutHeadlessRenderModel } from './capcut-draft.js';
import { CapCutHeadlessRenderAdapter } from './capcut-headless-render.js';
import type { MediaVideoAdapter } from './media-adapter.js';

export type MediaVideoCanvasPreset =
  | 'source'
  | 'vertical-1080x1920'
  | 'landscape-1920x1080'
  | 'square-1080';

export interface MediaVideoEditClip {
  input: string;
  sourceStartMs?: number;
  sourceDurationMs?: number;
  speed?: number;
  volume?: number;
  opacity?: number;
  scale?: number;
  rotationDeg?: number;
  flipHorizontal?: boolean;
  flipVertical?: boolean;
}

export interface MediaVideoEditCaption {
  text: string;
  startMs: number;
  durationMs: number;
}

export interface MediaVideoEditRecipe {
  canvas?: MediaVideoCanvasPreset;
  fps?: number;
  clips: MediaVideoEditClip[];
  captions?: MediaVideoEditCaption[];
}

interface MediaVideoEditOptions {
  rendererOptions?: ConstructorParameters<typeof CapCutHeadlessRenderAdapter>[5];
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

function sha256Text(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function finite(value: unknown, label: string, min: number, max: number, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label} must be between ${min} and ${max}.`);
  }
  return value;
}

function cleanRelative(value: string, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 1024 || value.includes('\0') || path.isAbsolute(value)) {
    throw new Error(`${label} must be one non-empty project-relative path.`);
  }
  return value.trim();
}

function canvasFor(
  preset: MediaVideoCanvasPreset,
  firstVideo: { width?: number; height?: number }
): { width: number; height: number } {
  if (preset === 'vertical-1080x1920') return { width: 1080, height: 1920 };
  if (preset === 'landscape-1920x1080') return { width: 1920, height: 1080 };
  if (preset === 'square-1080') return { width: 1080, height: 1080 };
  if (!Number.isInteger(firstVideo.width) || !Number.isInteger(firstVideo.height) ||
      (firstVideo.width ?? 0) < 16 || (firstVideo.height ?? 0) < 16 ||
      (firstVideo.width ?? 0) > 7680 || (firstVideo.height ?? 0) > 7680) {
    throw new Error('source canvas requires valid dimensions from the first video input.');
  }
  return { width: firstVideo.width!, height: firstVideo.height! };
}

function fpsFromProbe(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 && value <= 120 ? value : undefined;
}

export class MediaVideoEditAdapter {
  constructor(
    private readonly paths: PathGuard,
    private readonly runner: EngineeringCommandRunner,
    private readonly resources: EngineeringResourceManager,
    private readonly media: MediaVideoAdapter,
    private readonly options: MediaVideoEditOptions = {}
  ) {}

  private renderer(model: CapCutHeadlessRenderModel): CapCutHeadlessRenderAdapter {
    const drafts = {
      headlessRenderModel: async () => JSON.parse(JSON.stringify(model))
    } as unknown as CapCutDraftAdapter;
    return new CapCutHeadlessRenderAdapter(
      this.paths,
      this.runner,
      this.resources,
      drafts,
      this.media,
      this.options.rendererOptions
    );
  }

  private async compile(
    workspace: string,
    projectPath: string,
    recipe: MediaVideoEditRecipe
  ): Promise<{ model: CapCutHeadlessRenderModel; sourceEvidence: Array<{ input: string; sha256: string; bytes: number }> }> {
    if (!recipe || typeof recipe !== 'object') throw new Error('video edit recipe is required.');
    if (!Array.isArray(recipe.clips) || recipe.clips.length < 1 || recipe.clips.length > 64) {
      throw new Error('video edit recipe requires 1..64 clips.');
    }
    const captions = recipe.captions ?? [];
    if (!Array.isArray(captions) || captions.length > 64) throw new Error('video edit recipe supports at most 64 captions.');

    const sourceCache = new Map<string, {
      absolute: string;
      sha256: string;
      bytes: number;
      durationMs: number;
      hasAudio: boolean;
      width?: number;
      height?: number;
      fps?: number;
    }>();

    for (let index = 0; index < recipe.clips.length; index += 1) {
      const input = cleanRelative(recipe.clips[index]!.input, `clips[${index}].input`);
      if (sourceCache.has(input)) continue;
      const absolute = await resolveExistingProjectPath(this.paths, workspace, projectPath, input, 'video edit input');
      const stat = await fs.stat(absolute);
      if (!stat.isFile() || stat.size <= 0) throw new Error(`video edit input '${input}' is not a non-empty file.`);
      const probe = await this.media.probeFile(workspace, projectPath, input, 10_000);
      const video = probe.streams.find((stream: { codecType?: string }) => stream.codecType === 'video');
      if (!video) throw new Error(`video edit input '${input}' has no video stream.`);
      const durationSeconds = probe.format.durationSeconds;
      if (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
        throw new Error(`video edit input '${input}' has no positive duration.`);
      }
      sourceCache.set(input, {
        absolute,
        sha256: await sha256File(absolute),
        bytes: stat.size,
        durationMs: durationSeconds * 1000,
        hasAudio: probe.streams.some((stream: { codecType?: string }) => stream.codecType === 'audio'),
        width: video.width,
        height: video.height,
        fps: fpsFromProbe(video.avgFps ?? video.nominalFps)
      });
    }

    const first = sourceCache.get(cleanRelative(recipe.clips[0]!.input, 'clips[0].input'))!;
    const canvas = canvasFor(recipe.canvas ?? 'source', first);
    const requestedFps = recipe.fps === undefined ? undefined : finite(recipe.fps, 'fps', 1, 60);
    const fps = requestedFps ?? first.fps ?? 30;
    const videos: CapCutHeadlessRenderModel['videos'] = [];
    let targetStartMs = 0;

    for (let index = 0; index < recipe.clips.length; index += 1) {
      const clip = recipe.clips[index]!;
      const input = cleanRelative(clip.input, `clips[${index}].input`);
      const source = sourceCache.get(input)!;
      const sourceStartMs = finite(clip.sourceStartMs, `clips[${index}].sourceStartMs`, 0, 604_800_000, 0);
      if (sourceStartMs >= source.durationMs) throw new Error(`clips[${index}] starts beyond input duration.`);
      const available = source.durationMs - sourceStartMs;
      const sourceDurationMs = clip.sourceDurationMs === undefined
        ? available
        : finite(clip.sourceDurationMs, `clips[${index}].sourceDurationMs`, 1, 604_800_000);
      if (sourceDurationMs > available + 2) throw new Error(`clips[${index}] exceeds input duration.`);
      const speed = finite(clip.speed, `clips[${index}].speed`, 0.05, 20, 1);
      const volume = finite(clip.volume, `clips[${index}].volume`, 0, 1, 1);
      const opacity = finite(clip.opacity, `clips[${index}].opacity`, 0, 1, 1);
      const scale = finite(clip.scale, `clips[${index}].scale`, 0.1, 4, 1);
      const rotationDeg = finite(clip.rotationDeg, `clips[${index}].rotationDeg`, -360, 360, 0);
      const targetDurationMs = sourceDurationMs / speed;
      videos.push({
        id: `clip-${index + 1}`,
        sourcePath: source.absolute,
        sourceStartMs,
        sourceDurationMs,
        targetStartMs,
        targetDurationMs,
        speed,
        volume,
        opacity,
        scale,
        rotationDeg,
        x: 0,
        y: 0,
        flipHorizontal: clip.flipHorizontal === true,
        flipVertical: clip.flipVertical === true,
        hasAudio: source.hasAudio,
        width: source.width,
        height: source.height
      });
      targetStartMs += targetDurationMs;
    }

    const texts: CapCutHeadlessRenderModel['texts'] = captions.map((caption, index) => {
      if (typeof caption.text !== 'string' || caption.text.length < 1 || caption.text.length > 10_000 || caption.text.includes('\0')) {
        throw new Error(`captions[${index}].text must contain 1..10000 characters.`);
      }
      const startMs = finite(caption.startMs, `captions[${index}].startMs`, 0, 604_800_000);
      const durationMs = finite(caption.durationMs, `captions[${index}].durationMs`, 1, 604_800_000);
      if (startMs >= targetStartMs + 2) throw new Error(`captions[${index}] starts after the rendered video.`);
      return { id: `caption-${index + 1}`, text: caption.text, targetStartMs: startMs, targetDurationMs: durationMs };
    });

    const sourceEvidence = [...sourceCache.entries()].map(([input, source]) => ({
      input,
      sha256: source.sha256,
      bytes: source.bytes
    })).sort((a, b) => a.input.localeCompare(b.input));

    const canonical = {
      version: 1,
      canvas: recipe.canvas ?? 'source',
      fps,
      clips: recipe.clips.map((clip, index) => ({
        input: cleanRelative(clip.input, `clips[${index}].input`),
        sourceStartMs: videos[index]!.sourceStartMs,
        sourceDurationMs: videos[index]!.sourceDurationMs,
        speed: videos[index]!.speed,
        volume: videos[index]!.volume,
        opacity: videos[index]!.opacity,
        scale: videos[index]!.scale,
        rotationDeg: videos[index]!.rotationDeg,
        flipHorizontal: videos[index]!.flipHorizontal,
        flipVertical: videos[index]!.flipVertical
      })),
      captions: texts.map(item => ({
        textSha256: sha256Text(item.text),
        textLength: item.text.length,
        startMs: item.targetStartMs,
        durationMs: item.targetDurationMs
      })),
      sources: sourceEvidence
    };
    const digest = sha256Text(JSON.stringify(canonical));

    return {
      model: {
        projectId: `recipe-${digest.slice(0, 16)}`,
        sha256: digest,
        mirrorConsistent: true,
        durationMs: targetStartMs,
        fps,
        canvas,
        videos,
        texts,
        blockers: [],
        warnings: texts.length ? ['headless-text-style-is-generic-caption'] : []
      },
      sourceEvidence
    };
  }

  async plan(
    workspace: string,
    projectPath: string,
    recipe: MediaVideoEditRecipe,
    output: string
  ) {
    const compiled = await this.compile(workspace, projectPath, recipe);
    const delegated = await this.renderer(compiled.model).plan(
      workspace,
      projectPath,
      compiled.model.projectId,
      output
    );
    return {
      ready: delegated.ready,
      blockers: delegated.blockers,
      warnings: delegated.warnings,
      workspace,
      projectPath,
      output,
      backend: 'typed-video-edit-v1',
      fidelity: delegated.fidelity,
      canvas: delegated.draft.canvas,
      durationMs: delegated.draft.durationMs,
      fps: delegated.draft.fps,
      clips: delegated.draft.videoSegments.map((clip, index) => ({
        index,
        input: recipe.clips[index]!.input,
        sourceName: clip.sourceName,
        sourceStartMs: clip.sourceStartMs,
        sourceDurationMs: clip.sourceDurationMs,
        targetStartMs: clip.targetStartMs,
        targetDurationMs: clip.targetDurationMs,
        speed: clip.speed,
        volume: clip.volume,
        opacity: clip.opacity,
        scale: clip.scale,
        rotationDeg: clip.rotationDeg,
        flipHorizontal: clip.flipHorizontal,
        flipVertical: clip.flipVertical
      })),
      captions: delegated.draft.textSegments,
      sources: compiled.sourceEvidence,
      planSha256: delegated.planSha256
    };
  }

  async render(
    workspace: string,
    projectPath: string,
    recipe: MediaVideoEditRecipe,
    output: string,
    expectedPlanSha256: string,
    timeoutMs = 600_000
  ) {
    const compiled = await this.compile(workspace, projectPath, recipe);
    const delegated = await this.renderer(compiled.model).render(
      workspace,
      projectPath,
      compiled.model.projectId,
      output,
      expectedPlanSha256,
      timeoutMs
    );
    return {
      provider: 'typed-video-edit-v1',
      fidelity: delegated.fidelity,
      output: delegated.output,
      bytes: delegated.bytes,
      sha256: delegated.sha256,
      warnings: delegated.warnings,
      probe: delegated.probe,
      sourceEvidence: compiled.sourceEvidence,
      acceptance: delegated.acceptance
    };
  }
}
