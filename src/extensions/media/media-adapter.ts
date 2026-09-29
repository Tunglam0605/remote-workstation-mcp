import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { EngineeringCommandRunner } from '../../adapters/engineering/command-runner.js';
import { resolveExecutable } from '../../adapters/engineering/executable-resolver.js';
import { resolveExistingProjectPath } from '../../adapters/engineering/project-path.js';
import type { PathGuard } from '../../security/path-guard.js';
import { MediaProfileStore } from './profile-store.js';

export type MediaTranscodePreset = 'h264-1080p' | 'h264-720p' | 'h264-vertical-1080x1920' | 'web-preview';

const PRESETS: Record<MediaTranscodePreset, { width: number; height: number; crf: number; audioKbps: number }> = {
  'h264-1080p': { width: 1920, height: 1080, crf: 20, audioKbps: 192 },
  'h264-720p': { width: 1280, height: 720, crf: 21, audioKbps: 160 },
  'h264-vertical-1080x1920': { width: 1080, height: 1920, crf: 20, audioKbps: 192 },
  'web-preview': { width: 1280, height: 720, crf: 24, audioKbps: 128 }
};

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function resolveConfiguredExecutable(name: 'ffmpeg' | 'ffprobe'): Promise<string | undefined> {
  const envName = name === 'ffmpeg' ? 'RWMCP_FFMPEG_EXECUTABLE' : 'RWMCP_FFPROBE_EXECUTABLE';
  const override = process.env[envName]?.trim();
  if (override) {
    if (!path.isAbsolute(override)) throw new Error(`${envName} must be an absolute path.`);
    try { await fs.access(override); return override; } catch { throw new Error(`Configured ${envName} was not found.`); }
  }
  return await resolveExecutable(name);
}

function filterFor(preset: MediaTranscodePreset): string {
  const cfg = PRESETS[preset];
  return `scale=${cfg.width}:${cfg.height}:force_original_aspect_ratio=decrease,pad=${cfg.width}:${cfg.height}:(ow-iw)/2:(oh-ih)/2`;
}

function transcodeArgs(preset: MediaTranscodePreset, source: string, output: string): string[] {
  const cfg = PRESETS[preset];
  return [
    '-hide_banner',
    '-loglevel', 'error',
    '-n',
    '-i', source,
    '-vf', filterFor(preset),
    '-c:v', 'libx264',
    '-preset', preset === 'web-preview' ? 'veryfast' : 'medium',
    '-crf', String(cfg.crf),
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', `${cfg.audioKbps}k`,
    '-movflags', '+faststart',
    output
  ];
}

function boundedString(value: unknown, max = 256): string | undefined {
  if (typeof value !== 'string') return undefined;
  const out = value.trim().replace(/\s+/g, ' ');
  return out ? out.slice(0, max) : undefined;
}

function fraction(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^\d+\/\d+$/.test(value)) return undefined;
  const [a, b] = value.split('/').map(Number);
  if (!a || !b) return undefined;
  const out = a / b;
  return Number.isFinite(out) ? Math.round(out * 1000) / 1000 : undefined;
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

async function boundedJson(url: string, timeoutMs: number, maxBytes = 1024 * 1024): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: { accept: 'application/json', 'user-agent': 'RemoteWorkstationMCP/0.66' }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} from media provider.`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new Error('Media provider response exceeded safety bound.');
    return JSON.parse(bytes.toString('utf8'));
  } finally {
    clearTimeout(timer);
  }
}

export class MediaVideoAdapter {
  constructor(
    private readonly paths: PathGuard,
    private readonly runner: EngineeringCommandRunner,
    private readonly profiles: MediaProfileStore
  ) {}

  async providerStatus() {
    let ffmpeg: string | undefined;
    let ffprobe: string | undefined;
    const diagnostics: string[] = [];
    try { ffmpeg = await resolveConfiguredExecutable('ffmpeg'); } catch (error) { diagnostics.push(error instanceof Error ? error.message : String(error)); }
    try { ffprobe = await resolveConfiguredExecutable('ffprobe'); } catch (error) { diagnostics.push(error instanceof Error ? error.message : String(error)); }
    const npx = await resolveExecutable(process.platform === 'win32' ? 'npx.cmd' : 'npx').catch(() => undefined);
    return {
      supported: true,
      authority: 'typed-project-media',
      ffmpegAvailable: Boolean(ffmpeg),
      ffprobeAvailable: Boolean(ffprobe),
      remotionLauncherAvailable: Boolean(npx),
      ...(ffmpeg ? { ffmpegExecutable: ffmpeg } : {}),
      ...(ffprobe ? { ffprobeExecutable: ffprobe } : {}),
      ...(npx ? { remotionLauncher: npx } : {}),
      profiles: await this.profiles.status(),
      ...(diagnostics.length ? { diagnostics: diagnostics.slice(0, 8).map(item => item.slice(0, 512)) } : {}),
      intentionallyUnavailable: ['raw ffmpeg arguments', 'arbitrary process execution', 'arbitrary ComfyUI workflow submission', 'remote model download', 'implicit overwrite']
    };
  }

  async probeFile(workspace: string, projectPath: string, input: string, timeoutMs = 5_000) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 15_000) throw new Error('media probe timeoutMs must be 500..15000.');
    const source = await resolveExistingProjectPath(this.paths, workspace, projectPath, input, 'media input');
    const executable = await resolveConfiguredExecutable('ffprobe');
    if (!executable) throw new Error('ffprobe is unavailable.');
    const cwd = await this.paths.resolveExisting(workspace, projectPath);
    const args = [
      '-v', 'error',
      '-show_entries', 'format=format_name,duration,size,bit_rate:stream=index,codec_type,codec_name,width,height,pix_fmt,avg_frame_rate,r_frame_rate,sample_rate,channels',
      '-of', 'json',
      source
    ];
    const result = await this.runner.run(executable, args, cwd, timeoutMs);
    if (result.timedOut) throw new Error('ffprobe timed out.');
    if (result.exitCode !== 0) throw new Error(`ffprobe failed with exit code ${result.exitCode ?? 'null'}: ${result.stderr.slice(-512)}`);
    let parsed: any;
    try { parsed = JSON.parse(result.stdout); } catch { throw new Error('ffprobe returned invalid JSON.'); }
    const streams = Array.isArray(parsed?.streams) ? parsed.streams.slice(0, 64) : [];
    const format = parsed?.format && typeof parsed.format === 'object' ? parsed.format : {};
    return {
      input,
      backend: 'ffprobe',
      durationMs: result.durationMs,
      format: {
        name: boundedString(format.format_name, 128),
        durationSeconds: Number.isFinite(Number(format.duration)) ? Number(format.duration) : undefined,
        sizeBytes: Number.isFinite(Number(format.size)) ? Number(format.size) : undefined,
        bitRate: Number.isFinite(Number(format.bit_rate)) ? Number(format.bit_rate) : undefined
      },
      streams: streams.map((stream: any) => ({
        index: Number.isInteger(stream?.index) ? stream.index : undefined,
        codecType: boundedString(stream?.codec_type, 32),
        codecName: boundedString(stream?.codec_name, 64),
        width: Number.isInteger(stream?.width) ? stream.width : undefined,
        height: Number.isInteger(stream?.height) ? stream.height : undefined,
        pixelFormat: boundedString(stream?.pix_fmt, 64),
        avgFps: fraction(stream?.avg_frame_rate),
        nominalFps: fraction(stream?.r_frame_rate),
        sampleRate: Number.isFinite(Number(stream?.sample_rate)) ? Number(stream.sample_rate) : undefined,
        channels: Number.isInteger(stream?.channels) ? stream.channels : undefined
      }))
    };
  }

  private async resolveOutput(workspace: string, projectPath: string, output: string) {
    if (path.isAbsolute(output)) throw new Error('media output must be relative to the selected project root.');
    if (path.extname(output).toLowerCase() !== '.mp4') throw new Error('Media Phase 1 transcode output must use the .mp4 extension.');
    const projectRoot = await this.paths.resolveExisting(workspace, projectPath);
    const candidate = await this.paths.resolveForWrite(workspace, path.join(projectPath, output));
    const parentReal = await fs.realpath(path.dirname(candidate));
    if (!inside(projectRoot, parentReal)) throw new Error('media output parent cannot escape the selected project root.');
    const existing = await fs.lstat(candidate).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    if (existing) throw new Error('media output already exists; Phase 1 never overwrites outputs.');
    return { projectRoot, outputAbsolute: candidate };
  }

  async transcodePlan(workspace: string, projectPath: string, input: string, output: string, preset: MediaTranscodePreset) {
    const source = await resolveExistingProjectPath(this.paths, workspace, projectPath, input, 'media input');
    const { outputAbsolute } = await this.resolveOutput(workspace, projectPath, output);
    const ffmpeg = await resolveConfiguredExecutable('ffmpeg');
    return {
      workspace,
      projectPath,
      input,
      output,
      preset,
      source,
      outputAbsolute,
      ffmpegAvailable: Boolean(ffmpeg),
      filter: filterFor(preset),
      overwritePolicy: 'fail-if-exists'
    };
  }

  async transcode(workspace: string, projectPath: string, input: string, output: string, preset: MediaTranscodePreset, timeoutMs = 120_000) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 900_000) throw new Error('media transcode timeoutMs must be 1000..900000.');
    const source = await resolveExistingProjectPath(this.paths, workspace, projectPath, input, 'media input');
    const { projectRoot, outputAbsolute } = await this.resolveOutput(workspace, projectPath, output);
    const executable = await resolveConfiguredExecutable('ffmpeg');
    if (!executable) throw new Error('ffmpeg is unavailable.');
    let accepted = false;
    try {
      const result = await this.runner.run(executable, transcodeArgs(preset, source, outputAbsolute), projectRoot, timeoutMs);
      if (result.timedOut) throw new Error('ffmpeg transcode timed out.');
      if (result.exitCode !== 0) throw new Error(`ffmpeg failed with exit code ${result.exitCode ?? 'null'}: ${result.stderr.slice(-1024)}`);
      const stat = await fs.stat(outputAbsolute);
      if (!stat.isFile() || stat.size <= 0) throw new Error('ffmpeg reported success but did not create a non-empty output file.');
      const sha256 = await sha256File(outputAbsolute);
      accepted = true;
      return {
        input,
        output,
        preset,
        backend: 'ffmpeg',
        durationMs: result.durationMs,
        bytes: stat.size,
        sha256
      };
    } finally {
      if (!accepted) await fs.rm(outputAbsolute, { force: true }).catch(() => undefined);
    }
  }

  async remotionStatus(workspace: string, projectPath: string) {
    const projectRoot = await this.paths.resolveExisting(workspace, projectPath);
    const filename = path.join(projectRoot, 'package.json');
    const raw = await fs.readFile(filename, 'utf8').catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    if (!raw) return { configured: false, reason: 'package.json not found' };
    if (Buffer.byteLength(raw, 'utf8') > 2 * 1024 * 1024) throw new Error('package.json exceeds 2 MiB safety bound.');
    const pkg = JSON.parse(raw) as Record<string, any>;
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    const packages = ['remotion', '@remotion/cli', '@remotion/renderer'].filter(name => typeof deps[name] === 'string');
    const scripts = pkg.scripts && typeof pkg.scripts === 'object'
      ? Object.keys(pkg.scripts).filter(name => /remotion|render|video/i.test(name)).slice(0, 32)
      : [];
    return {
      configured: packages.length > 0,
      packages: packages.map(name => ({ name, version: String(deps[name]).slice(0, 64) })),
      scripts
    };
  }

  async comfyUiStatus(profileId: string, timeoutMs = 3_000) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 10_000) throw new Error('ComfyUI timeoutMs must be 250..10000.');
    const profile = await this.profiles.get(profileId);
    const host = profile.host.includes(':') ? `[${profile.host}]` : profile.host;
    const base = `${profile.scheme}://${host}:${profile.port}`;
    const started = Date.now();
    const [system, queue] = await Promise.all([
      boundedJson(`${base}/system_stats`, timeoutMs),
      boundedJson(`${base}/queue`, timeoutMs)
    ]);
    const systemObj = system && typeof system === 'object' ? system as any : {};
    const sys = systemObj.system && typeof systemObj.system === 'object' ? systemObj.system : {};
    const devices = Array.isArray(systemObj.devices) ? systemObj.devices.slice(0, 16) : [];
    const queueObj = queue && typeof queue === 'object' ? queue as any : {};
    return {
      profileId,
      endpoint: base,
      reachable: true,
      durationMs: Date.now() - started,
      system: {
        os: boundedString(sys.os, 64),
        pythonVersion: boundedString(sys.python_version, 128),
        pytorchVersion: boundedString(sys.pytorch_version, 128),
        comfyuiVersion: boundedString(sys.comfyui_version, 128)
      },
      devices: devices.map((device: any) => ({
        name: boundedString(device?.name, 128),
        type: boundedString(device?.type, 64),
        vramTotal: Number.isFinite(Number(device?.vram_total)) ? Number(device.vram_total) : undefined,
        vramFree: Number.isFinite(Number(device?.vram_free)) ? Number(device.vram_free) : undefined
      })),
      queue: {
        running: Array.isArray(queueObj.queue_running) ? queueObj.queue_running.length : 0,
        pending: Array.isArray(queueObj.queue_pending) ? queueObj.queue_pending.length : 0
      }
    };
  }
}
