import net from 'node:net';
import type { CameraProfile } from './profile-store.js';

export interface RtspProbeResult {
  profileId: string;
  endpoint: string;
  method: 'DESCRIBE';
  reachable: boolean;
  statusCode?: number;
  statusText?: string;
  latencyMs: number;
  authRequired: boolean;
  authSchemes: string[];
  server?: string;
  contentType?: string;
  contentLength?: number;
  tracks: Array<{ media: string; payloadTypes: number[]; codecs: string[]; control?: string }>;
  sdpBytes: number;
}

function endpoint(profile: CameraProfile): string {
  const host = net.isIP(profile.host) === 6 ? `[${profile.host}]` : profile.host;
  return `rtsp://${host}:${profile.port}${profile.path}`;
}

function parseAuthSchemes(header: string | undefined): string[] {
  if (!header) return [];
  const schemes = header
    .split(',')
    .map(part => part.trim().split(/\s+/, 1)[0]?.toLowerCase())
    .filter((value): value is string => Boolean(value))
    .filter(value => ['basic', 'digest', 'bearer'].includes(value));
  return [...new Set(schemes)].slice(0, 8);
}

export function parseSdp(body: string) {
  const tracks: Array<{ media: string; payloadTypes: number[]; codecs: string[]; control?: string }> = [];
  let current: (typeof tracks)[number] | undefined;
  for (const raw of body.split(/\r?\n/).slice(0, 512)) {
    const line = raw.trim();
    if (line.startsWith('m=')) {
      const fields = line.slice(2).split(/\s+/);
      const media = (fields[0] ?? 'unknown').slice(0, 32);
      const payloadTypes = fields.slice(3).map(v => Number.parseInt(v, 10)).filter(Number.isFinite).slice(0, 32);
      current = { media, payloadTypes, codecs: [] };
      tracks.push(current);
      continue;
    }
    if (!current) continue;
    const rtpmap = /^a=rtpmap:(\d+)\s+([^/\s]+)/i.exec(line);
    if (rtpmap?.[2]) {
      const codec = rtpmap[2].slice(0, 64);
      if (!current.codecs.includes(codec)) current.codecs.push(codec);
      continue;
    }
    const control = /^a=control:(.+)$/i.exec(line)?.[1]?.trim();
    if (control && !current.control) current.control = control.slice(0, 256);
  }
  return tracks.slice(0, 32);
}

export async function probeRtsp(profile: CameraProfile, timeoutMs = 3_000): Promise<RtspProbeResult> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 10_000) {
    throw new Error('RTSP timeoutMs must be in range 250..10000.');
  }
  const url = endpoint(profile);
  const started = Date.now();
  const socket = net.createConnection({ host: profile.host, port: profile.port });
  socket.setNoDelay(true);
  let buffer = Buffer.alloc(0);

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('RTSP connect timed out.')), timeoutMs);
      socket.once('connect', () => { clearTimeout(timer); resolve(); });
      socket.once('error', error => { clearTimeout(timer); reject(error); });
    });

    const request = [
      `DESCRIBE ${url} RTSP/1.0`,
      'CSeq: 1',
      'Accept: application/sdp',
      'User-Agent: RemoteWorkstationMCP/0.66',
      '',
      ''
    ].join('\r\n');
    socket.write(request, 'utf8');

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('RTSP response timed out.')), timeoutMs);
      const onData = (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length > 128 * 1024) {
          clearTimeout(timer);
          reject(new Error('RTSP response exceeded 128 KiB safety bound.'));
          return;
        }
        const split = buffer.indexOf('\r\n\r\n');
        if (split < 0) return;
        const headerText = buffer.subarray(0, split).toString('utf8');
        const lengthLine = headerText.split(/\r\n/).find(line => /^content-length:/i.test(line));
        const contentLength = lengthLine ? Number.parseInt(lengthLine.split(':', 2)[1]?.trim() ?? '0', 10) : 0;
        if (!Number.isFinite(contentLength) || contentLength < 0 || contentLength > 64 * 1024) {
          clearTimeout(timer);
          reject(new Error('RTSP Content-Length is invalid or exceeds 64 KiB.'));
          return;
        }
        if (buffer.length >= split + 4 + contentLength) {
          clearTimeout(timer);
          socket.off('data', onData);
          resolve();
        }
      };
      socket.on('data', onData);
      socket.once('error', error => { clearTimeout(timer); reject(error); });
      socket.once('close', () => {
        const split = buffer.indexOf('\r\n\r\n');
        if (split >= 0) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
  } finally {
    socket.destroy();
  }

  const split = buffer.indexOf('\r\n\r\n');
  if (split < 0) throw new Error('RTSP response did not contain complete headers.');
  const headerText = buffer.subarray(0, split).toString('utf8');
  const lines = headerText.split(/\r\n/);
  const status = /^RTSP\/1\.0\s+(\d{3})\s*(.*)$/i.exec(lines[0] ?? '');
  if (!status) throw new Error('RTSP response status line is malformed.');
  const headers = new Map<string, string>();
  for (const line of lines.slice(1, 128)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (!headers.has(key)) headers.set(key, value);
  }
  const statusCode = Number.parseInt(status[1]!, 10);
  const contentLength = Number.parseInt(headers.get('content-length') ?? '0', 10);
  const body = buffer.subarray(split + 4, split + 4 + (Number.isFinite(contentLength) ? contentLength : 0)).toString('utf8');

  return {
    profileId: profile.id,
    endpoint: url,
    method: 'DESCRIBE',
    reachable: true,
    statusCode,
    statusText: (status[2] ?? '').trim().slice(0, 128),
    latencyMs: Date.now() - started,
    authRequired: statusCode === 401 || statusCode === 403,
    authSchemes: parseAuthSchemes(headers.get('www-authenticate')),
    ...(headers.get('server') ? { server: headers.get('server')!.slice(0, 256) } : {}),
    ...(headers.get('content-type') ? { contentType: headers.get('content-type')!.slice(0, 128) } : {}),
    ...(Number.isFinite(contentLength) ? { contentLength } : {}),
    tracks: statusCode === 200 ? parseSdp(body) : [],
    sdpBytes: statusCode === 200 ? Buffer.byteLength(body, 'utf8') : 0
  };
}
