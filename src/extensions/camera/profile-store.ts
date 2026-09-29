import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { z } from 'zod/v4';
import { setupConfigDir } from '../../setup/settings.js';

const profileId = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
const label = z.string().min(1).max(128).optional();

const cameraProfile = z.object({
  id: profileId,
  label,
  host: z.string().min(1).max(253),
  port: z.number().int().min(1).max(65_535).default(554),
  path: z.string().min(1).max(512).default('/'),
  transport: z.enum(['tcp', 'udp']).default('tcp'),
  auth: z.literal('none').default('none')
}).strict();

const configSchema = z.object({
  version: z.literal(1),
  profiles: z.array(cameraProfile).max(64)
}).strict();

export type CameraProfile = z.infer<typeof cameraProfile>;

export function cameraProfilesPath(): string {
  return path.join(setupConfigDir(), 'camera-profiles.json');
}

function validateHost(host: string): string {
  const value = host.trim();
  if (!value || value.includes('\0') || /[\s/\\?#@]/.test(value)) {
    throw new Error('Camera profile host must be a hostname or IP address without scheme/path/userinfo.');
  }
  if (net.isIP(value)) return value;
  if (value.length > 253 || value.startsWith('.') || value.endsWith('.')) throw new Error('Camera profile host is invalid.');
  const labels = value.split('.');
  if (labels.some(part => !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(part))) {
    throw new Error('Camera profile host is invalid.');
  }
  return value;
}

function validatePath(value: string): string {
  const p = value.trim();
  if (!p.startsWith('/')) throw new Error('Camera RTSP path must start with /.');
  if (p.includes('\0') || p.includes('@') || p.includes('?') || p.includes('#')) {
    throw new Error('Camera RTSP path cannot contain userinfo, query or fragment data in Phase 1.');
  }
  if (p.split('/').some(segment => segment === '..')) throw new Error('Camera RTSP path traversal is not allowed.');
  return p;
}

export class CameraProfileStore {
  constructor(private readonly filename = cameraProfilesPath()) {}

  async list(): Promise<CameraProfile[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filename, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    if (Buffer.byteLength(raw, 'utf8') > 128 * 1024) throw new Error('Camera profile file exceeds 128 KiB.');
    const parsed = configSchema.parse(JSON.parse(raw));
    const seen = new Set<string>();
    return parsed.profiles.map(profile => {
      if (seen.has(profile.id)) throw new Error(`Duplicate camera profile id '${profile.id}'.`);
      seen.add(profile.id);
      return {
        ...profile,
        host: validateHost(profile.host),
        path: validatePath(profile.path)
      };
    });
  }

  async get(id: string): Promise<CameraProfile> {
    const selected = profileId.parse(id);
    const profile = (await this.list()).find(item => item.id === selected);
    if (!profile) throw new Error(`Camera profile '${selected}' is not configured.`);
    return profile;
  }

  async status() {
    const profiles = await this.list();
    return {
      configured: profiles.length > 0,
      profileCount: profiles.length
    };
  }
}
