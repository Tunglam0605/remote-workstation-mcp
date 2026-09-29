import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { z } from 'zod/v4';
import { setupConfigDir } from '../../setup/settings.js';

const profileId = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
const label = z.string().min(1).max(128).optional();

const comfyUiProfile = z.object({
  id: profileId,
  label,
  kind: z.literal('comfyui'),
  host: z.string().min(1).max(253),
  port: z.number().int().min(1).max(65_535).default(8188),
  scheme: z.literal('http').default('http')
}).strict();

const configSchema = z.object({
  version: z.literal(1),
  profiles: z.array(comfyUiProfile).max(32)
}).strict();

export type MediaProviderProfile = z.infer<typeof comfyUiProfile>;

export function mediaProfilesPath(): string {
  return path.join(setupConfigDir(), 'media-profiles.json');
}

function validateHost(host: string): string {
  const value = host.trim();
  if (!value || value.includes('\0') || /[\s/\\?#@]/.test(value)) {
    throw new Error('Media provider host must be a hostname or IP address without scheme/path/userinfo.');
  }
  if (net.isIP(value)) return value;
  if (value.length > 253 || value.startsWith('.') || value.endsWith('.')) throw new Error('Media provider host is invalid.');
  const labels = value.split('.');
  if (labels.some(part => !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(part))) {
    throw new Error('Media provider host is invalid.');
  }
  return value;
}

export class MediaProfileStore {
  constructor(private readonly filename = mediaProfilesPath()) {}

  async list(): Promise<MediaProviderProfile[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filename, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    if (Buffer.byteLength(raw, 'utf8') > 64 * 1024) throw new Error('Media profile file exceeds 64 KiB.');
    const parsed = configSchema.parse(JSON.parse(raw));
    const seen = new Set<string>();
    return parsed.profiles.map(profile => {
      if (seen.has(profile.id)) throw new Error(`Duplicate media profile id '${profile.id}'.`);
      seen.add(profile.id);
      return { ...profile, host: validateHost(profile.host) };
    });
  }

  async get(id: string): Promise<MediaProviderProfile> {
    const selected = profileId.parse(id);
    const profile = (await this.list()).find(item => item.id === selected);
    if (!profile) throw new Error(`Media provider profile '${selected}' is not configured.`);
    return profile;
  }

  async status() {
    const profiles = await this.list();
    return {
      configured: profiles.length > 0,
      profileCount: profiles.length,
      byKind: profiles.reduce<Record<string, number>>((acc, item) => {
        acc[item.kind] = (acc[item.kind] ?? 0) + 1;
        return acc;
      }, {})
    };
  }
}
