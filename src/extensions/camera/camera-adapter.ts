import fs from 'node:fs/promises';
import path from 'node:path';
import type { EngineeringCommandRunner } from '../../adapters/engineering/command-runner.js';
import { resolveExecutable } from '../../adapters/engineering/executable-resolver.js';
import { CameraProfileStore } from './profile-store.js';
import { probeRtsp } from './rtsp-client.js';
import { OnvifPtzClient, type PtzVector } from './onvif-ptz.js';

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
  private readonly ptz = new OnvifPtzClient();

  constructor(
    private readonly store: CameraProfileStore,
    private readonly runner: EngineeringCommandRunner
  ) {}

  async providerStatus() {
    let ffprobe: string | undefined;
    let diagnostic: string | undefined;
    try { ffprobe = await resolveFfprobe(); } catch (error) { diagnostic = error instanceof Error ? error.message : String(error); }
    const profiles = await this.store.status();
    return {
      supported: true,
      authority: 'read-observe-plus-bounded-ptz',
      rtspProbeBackend: 'node-net',
      ffprobeAvailable: Boolean(ffprobe),
      ptz: {
        backend: 'onvif-wsse',
        configuredProfiles: profiles.ptzProfileCount,
        credentialReadyProfiles: profiles.ptzCredentialReadyCount,
        moveDurationMaxMs: 2_000,
        autoStop: true
      },
      ...(ffprobe ? { ffprobeExecutable: ffprobe } : {}),
      ...(diagnostic ? { ffprobeDiagnostic: diagnostic.slice(0, 512) } : {}),
      intentionallyUnavailable: ['camera configuration', 'two-way audio', 'snapshot/write artifacts', 'raw SOAP/XML', 'arbitrary PTZ endpoint', 'unbounded continuous movement']
    };
  }

  async listProfiles() {
    const profiles = await this.store.list();
    return {
      ...(await this.store.status()),
      profiles: profiles.map(profile => ({
        ...this.store.toPublicProfile(profile),
        endpoint: endpoint(profile)
      }))
    };
  }

  async inspectProfile(id: string) {
    const profile = await this.store.get(id);
    return {
      ...this.store.toPublicProfile(profile),
      endpoint: endpoint(profile)
    };
  }

  async probe(id: string, timeoutMs = 3_000) {
    return await probeRtsp(await this.store.get(id), timeoutMs);
  }

  async metadata(id: string, timeoutMs = 5_000) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 15_000) {
      throw new Error('Camera metadata timeoutMs must be in range 500..15000.');
    }
    const profile = await this.store.get(id);
    if (profile.auth !== 'none') throw new Error('Camera metadata supports anonymous RTSP profiles only.');
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

  async ptzStatus(id: string, timeoutMs = 3_000) {
    return await this.ptz.status(await this.store.resolvePtz(id), timeoutMs);
  }

  async ptzMove(id: string, vector: PtzVector, durationMs = 250, timeoutMs = 3_000) {
    return await this.ptz.move(await this.store.resolvePtz(id), vector, durationMs, timeoutMs);
  }

  async ptzStop(id: string, timeoutMs = 3_000) {
    return await this.ptz.stop(await this.store.resolvePtz(id), timeoutMs);
  }

  async fleetProbe(options: { profileIds?: string[]; concurrency?: number; timeoutMs?: number } = {}) {
    const timeoutMs = options.timeoutMs ?? 3_000;
    const concurrency = options.concurrency ?? 4;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 10_000) throw new Error('Camera fleet timeoutMs must be in range 250..10000.');
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('Camera fleet concurrency must be in range 1..8.');

    const allProfiles = await this.store.list();
    const requested = options.profileIds ?? [];
    if (requested.length > 32) throw new Error('Camera fleet probe accepts at most 32 profile IDs.');
    const uniqueRequested = [...new Set(requested)];
    if (uniqueRequested.length !== requested.length) throw new Error('Camera fleet profile IDs must be unique.');

    const selected = uniqueRequested.length
      ? uniqueRequested.map(id => {
          const profile = allProfiles.find(item => item.id === id);
          if (!profile) throw new Error(`Camera profile '${id}' is not configured.`);
          return profile;
        })
      : allProfiles.slice(0, 32);

    const startedAt = Date.now();
    const results = new Array<any>(selected.length);
    let cursor = 0;
    const worker = async () => {
      while (true) {
        const index = cursor++;
        const profile = selected[index];
        if (!profile) return;
        try {
          const probe = await probeRtsp(profile, timeoutMs);
          const codecs = [...new Set(probe.tracks.flatMap(track => track.codecs))].slice(0, 16);
          results[index] = {
            profileId: profile.id,
            label: profile.label,
            ok: probe.statusCode === 200,
            statusCode: probe.statusCode,
            latencyMs: probe.latencyMs,
            authRequired: probe.authRequired,
            videoTracks: probe.tracks.filter(track => track.media === 'video').length,
            audioTracks: probe.tracks.filter(track => track.media === 'audio').length,
            codecs
          };
        } catch (error) {
          results[index] = {
            profileId: profile.id,
            label: profile.label,
            ok: false,
            error: (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 256)
          };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, selected.length)) }, () => worker()));

    const completed = results.filter(Boolean);
    const successfulLatencies = completed
      .filter(item => item.ok && Number.isFinite(item.latencyMs))
      .map(item => Number(item.latencyMs))
      .sort((a, b) => a - b);
    const percentile = (p: number) => {
      if (!successfulLatencies.length) return undefined;
      const index = Math.min(successfulLatencies.length - 1, Math.max(0, Math.ceil(successfulLatencies.length * p) - 1));
      return successfulLatencies[index];
    };

    return {
      requestedProfileIds: uniqueRequested,
      selectedCount: selected.length,
      concurrency,
      timeoutMs,
      durationMs: Date.now() - startedAt,
      summary: {
        healthy: completed.filter(item => item.ok).length,
        failed: completed.filter(item => !item.ok).length,
        authRequired: completed.filter(item => item.authRequired).length,
        p50LatencyMs: percentile(0.5),
        p95LatencyMs: percentile(0.95)
      },
      cameras: completed
    };
  }

}
