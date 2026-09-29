import crypto from 'node:crypto';
import net from 'node:net';
import type { CameraProfile } from './profile-store.js';

type ResolvedPtzProfile = CameraProfile & {
  ptz: NonNullable<CameraProfile['ptz']> & { password: string };
};

export interface PtzVector {
  pan: number;
  tilt: number;
  zoom: number;
}

function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function clampUnit(value: number, label: string): number {
  if (!Number.isFinite(value) || value < -1 || value > 1) throw new Error(`${label} must be in range -1..1.`);
  return Math.round(value * 1000) / 1000;
}

function serviceUrl(profile: ResolvedPtzProfile): string {
  const host = net.isIP(profile.host) === 6 ? `[${profile.host}]` : profile.host;
  return `${profile.ptz.scheme}://${host}:${profile.ptz.port}${profile.ptz.path}`;
}

function securityHeader(username: string, password: string) {
  const created = new Date().toISOString();
  const nonce = crypto.randomBytes(16);
  const digest = crypto
    .createHash('sha1')
    .update(Buffer.concat([nonce, Buffer.from(created, 'utf8'), Buffer.from(password, 'utf8')]))
    .digest('base64');
  return {
    created,
    nonce: nonce.toString('base64'),
    digest,
    xml: `<wsse:Security s:mustUnderstand="1"><wsse:UsernameToken><wsse:Username>${xml(username)}</wsse:Username><wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</wsse:Password><wsse:Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonce.toString('base64')}</wsse:Nonce><wsu:Created>${created}</wsu:Created></wsse:UsernameToken></wsse:Security>`
  };
}

function envelope(profile: ResolvedPtzProfile, body: string): string {
  const sec = securityHeader(profile.ptz.username, profile.ptz.password);
  return `<?xml version="1.0" encoding="UTF-8"?>` +
    `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tt="http://www.onvif.org/ver10/schema" xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl" xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd" xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd"><s:Header>${sec.xml}</s:Header><s:Body>${body}</s:Body></s:Envelope>`;
}

async function postSoap(profile: ResolvedPtzProfile, action: string, body: string, timeoutMs: number) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 10_000) throw new Error('ONVIF timeoutMs must be 250..10000.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetch(serviceUrl(profile), {
      method: 'POST',
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        'content-type': `application/soap+xml; charset=utf-8; action="${action}"`,
        'user-agent': 'RemoteWorkstationMCP/0.66'
      },
      body: envelope(profile, body)
    });
    if (response.status >= 300 && response.status < 400) throw new Error('ONVIF redirect responses are not followed.');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 256 * 1024) throw new Error('ONVIF response exceeded 256 KiB safety bound.');
    const text = bytes.toString('utf8');
    if (!response.ok) {
      const fault = /<[^>]*Reason[^>]*>[\s\S]*?<[^>]*Text[^>]*>([\s\S]*?)<\//i.exec(text)?.[1]?.trim();
      throw new Error(`ONVIF HTTP ${response.status}${fault ? `: ${fault.slice(0, 256)}` : ''}`);
    }
    return {
      url: serviceUrl(profile),
      status: response.status,
      latencyMs: Date.now() - startedAt,
      body: text
    };
  } finally {
    clearTimeout(timer);
  }
}

function parseNumberAttribute(xmlText: string, localName: string, attr: string): number | undefined {
  const pattern = new RegExp(`<[^>]*${localName}[^>]*\\b${attr}="(-?\\d+(?:\\.\\d+)?)"[^>]*>`, 'i');
  const match = pattern.exec(xmlText)?.[1];
  if (match === undefined) return undefined;
  const value = Number(match);
  return Number.isFinite(value) ? value : undefined;
}

function parseMoveStatus(xmlText: string, localName: string): string | undefined {
  const pattern = new RegExp(`<[^>]*${localName}[^>]*>([^<]+)<\\/`, 'i');
  const value = pattern.exec(xmlText)?.[1]?.trim();
  return value ? value.slice(0, 64) : undefined;
}

export class OnvifPtzClient {
  async status(profile: ResolvedPtzProfile, timeoutMs = 3_000) {
    const body = `<tptz:GetStatus><tptz:ProfileToken>${xml(profile.ptz.profileToken)}</tptz:ProfileToken></tptz:GetStatus>`;
    const response = await postSoap(profile, 'http://www.onvif.org/ver20/ptz/wsdl/GetStatus', body, timeoutMs);
    const pan = parseNumberAttribute(response.body, 'PanTilt', 'x');
    const tilt = parseNumberAttribute(response.body, 'PanTilt', 'y');
    const zoom = parseNumberAttribute(response.body, 'Zoom', 'x');
    return {
      profileId: profile.id,
      endpoint: response.url,
      latencyMs: response.latencyMs,
      position: {
        ...(pan !== undefined ? { pan } : {}),
        ...(tilt !== undefined ? { tilt } : {}),
        ...(zoom !== undefined ? { zoom } : {})
      },
      moveStatus: {
        panTilt: parseMoveStatus(response.body, 'PanTilt'),
        zoom: parseMoveStatus(response.body, 'Zoom')
      }
    };
  }

  async stop(profile: ResolvedPtzProfile, timeoutMs = 3_000) {
    const body = `<tptz:Stop><tptz:ProfileToken>${xml(profile.ptz.profileToken)}</tptz:ProfileToken><tptz:PanTilt>true</tptz:PanTilt><tptz:Zoom>true</tptz:Zoom></tptz:Stop>`;
    const response = await postSoap(profile, 'http://www.onvif.org/ver20/ptz/wsdl/Stop', body, timeoutMs);
    return {
      profileId: profile.id,
      stopped: true,
      latencyMs: response.latencyMs
    };
  }

  async move(profile: ResolvedPtzProfile, vector: PtzVector, durationMs = 250, timeoutMs = 3_000) {
    if (!Number.isInteger(durationMs) || durationMs < 50 || durationMs > 2_000) throw new Error('PTZ durationMs must be in range 50..2000.');
    const pan = clampUnit(vector.pan, 'pan');
    const tilt = clampUnit(vector.tilt, 'tilt');
    const zoom = clampUnit(vector.zoom, 'zoom');
    if (pan === 0 && tilt === 0 && zoom === 0) throw new Error('PTZ move requires at least one non-zero axis.');

    const timeoutSeconds = Math.min(2.5, Math.max(0.1, durationMs / 1000 + 0.25));
    const body = `<tptz:ContinuousMove><tptz:ProfileToken>${xml(profile.ptz.profileToken)}</tptz:ProfileToken><tptz:Velocity><tt:PanTilt x="${pan}" y="${tilt}"/><tt:Zoom x="${zoom}"/></tptz:Velocity><tptz:Timeout>PT${timeoutSeconds.toFixed(2)}S</tptz:Timeout></tptz:ContinuousMove>`;
    const move = await postSoap(profile, 'http://www.onvif.org/ver20/ptz/wsdl/ContinuousMove', body, timeoutMs);
    const startedAt = Date.now();
    try {
      await new Promise(resolve => setTimeout(resolve, durationMs));
    } finally {
      await this.stop(profile, timeoutMs);
    }
    return {
      profileId: profile.id,
      vector: { pan, tilt, zoom },
      requestedDurationMs: durationMs,
      elapsedMs: Date.now() - startedAt,
      moveRequestLatencyMs: move.latencyMs,
      autoStopped: true
    };
  }
}
