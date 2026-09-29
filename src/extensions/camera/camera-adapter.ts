import fs from 'node:fs/promises';
import path from 'node:path';
import type { EngineeringCommandRunner } from '../../adapters/engineering/command-runner.js';
import { resolveExecutable } from '../../adapters/engineering/executable-resolver.js';
import { CameraProfileStore } from './profile-store.js';
import { probeRtsp } from './rtsp-client.js';

function fraction(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^\d+\/\d+$/.test(value)) return undefined;
  const [a,b] = value.split('/').map(Number);
  if (!a || !b) return undefined;
  const out = a / b;
  return Number.isFinite(out) ? Math.round(out * 1000) / 1000 : undefined;
}

async function resolveFfprobe(): Promise<string | undefined> {
  const override = process.env.RWMCP_FFPROBE_EXECUTABLE?.trim();
  if (override) {
    if (!path.isAbsolute(override)) throw new Error('RWMCP_FFPROBE_EXECUTABLE must be an absolute path.');
    try { await fs.access(override); return override; } catch { throw new Error('Configured RWMCP_FFPROBE_EXECUTABLE was not found.'); }
  }
  return await resolveExecutable('ffprobe');
}

function endpoint(profile: Awaited<ReturnType<CameraProfileStore['get']>>): string {
  const host = profile.host.includes(':') ? `[${profile.host}]` : profile.host;
  return `rtsp://${host}:${profile.port}${profile.path}`;
}

export class CameraDiagnosticsAdapter {
  constructor(
    private readonly store: CameraProfileStore,
    private readonly runner: EngineeringCommandRunner
  ) {}

  async providerStatus() {
    let ffprobe: string | undefined;
    let diagnostic: string | undefined;
    try { ffprobe = await resolveFfprobe(); } catch (error) { diagnostic = error instanceof Error ? error.message : String(error); }
    return {
      supported: true,
      authority: 'read-only-observation',
      rtspProbeBackend: 'node-net',
      ffprobeAvailable: Boolean(ffprobe),
      ...(ffprobe ? { ffprobeExecutable: ffprobe } : {}),
      ...(diagnostic ? { ffprobeDiagnostic: diagnostic.slice(0, 512) } : {}),
      intentionallyUnavailable: ['camera configuration', 'PTZ control', 'two-way audio', 'credential handling', 'snapshot/write artifacts']
    };
  }

  async listProfiles() {
    const profiles = await this.store.list();
    return {
      ...(await this.store.status()),
      profiles: profiles.map(profile => ({ ...profile, endpoint: endpoint(profile) }))
    };
  }

  async inspectProfile(id: string) {
    const profile = await this.store.get(id);
    return { ...profile, endpoint: endpoint(profile) };
  }

  async probe(id: string, timeoutMs = 3_000) {
    return await probeRtsp(await this.store.get(id), timeoutMs);
  }

  async metadata(id: string, timeoutMs = 5_000) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 15_000) {
      throw new Error('Camera metadata timeoutMs must be in range 500..15000.');
    }
    const profile = await this.store.get(id);
    if (profile.auth !== 'none') throw new Error('Camera metadata Phase 1 supports anonymous RTSP profiles only.');
    const executable = await resolveFfprobe();
    if (!executable) throw new Error('ffprobe is unavailable. Install FFmpeg/ffprobe or configure owner-controlled RWMCP_FFPROBE_EXECUTABLE.');
    const url = endpoint(profile);
    const args = [
      '-v','error',
      '-rtsp_transport', profile.transport,
      '-analyzeduration','1000000',
      '-probesize','1000000',
      '-show_entries','stream=index,codec_type,codec_name,width,height,pix_fmt,avg_frame_rate,r_frame_rate',
      '-of','json',
      url
    ];
    const result = await this.runner.run(executable, args, process.cwd(), timeoutMs);
    if (result.timedOut) throw new Error('ffprobe timed out before bounded stream metadata was available.');
    if (result.exitCode !== 0) throw new Error(`ffprobe failed with exit code ${result.exitCode ?? 'null'}: ${result.stderr.slice(-512)}`);
    let parsed: any;
    try { parsed = JSON.parse(result.stdout); } catch { throw new Error('ffprobe returned invalid JSON.'); }
    const streams = Array.isArray(parsed?.streams) ? parsed.streams.slice(0, 32) : [];
    return {
      profileId: profile.id,
      endpoint: url,
      backend: 'ffprobe',
      durationMs: result.durationMs,
      streams: streams.map((stream: any) => ({
        index: Number.isInteger(stream?.index) ? stream.index : undefined,
        codecType: typeof stream?.codec_type === 'string' ? stream.codec_type.slice(0,32) : undefined,
        codecName: typeof stream?.codec_name === 'string' ? stream.codec_name.slice(0,64) : undefined,
        width: Number.isInteger(stream?.width) ? stream.width : undefined,
        height: Number.isInteger(stream?.height) ? stream.height : undefined,
        pixelFormat: typeof stream?.pix_fmt === 'string' ? stream.pix_fmt.slice(0,64) : undefined,
        avgFps: fraction(stream?.avg_frame_rate),
        nominalFps: fraction(stream?.r_frame_rate)
      }))
    };
  }
}
