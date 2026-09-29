import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { z } from 'zod/v4';
import { setupConfigDir } from '../../setup/settings.js';

const envName = z.string().min(1).max(128).regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const profileId = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);

const profileSchema = z.object({
  id: profileId,
  host: z.string().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  tls: z.boolean().default(false),
  username: z.string().min(1).max(128).optional(),
  passwordEnv: envName.optional(),
  servername: z.string().min(1).max(253).optional()
}).strict();

const configSchema = z.object({
  version: z.literal(1),
  profiles: z.array(profileSchema).max(16)
}).strict();

export type MqttProfile = z.infer<typeof profileSchema>;

export interface ResolvedMqttProfile extends MqttProfile {
  password?: string;
}

export function mqttProfilesPath(): string {
  return path.join(setupConfigDir(), 'mqtt-profiles.json');
}

function validateHost(host: string): string {
  const value = host.trim();
  if (!value || value.includes('\0') || /[\s/\\?#@]/.test(value)) {
    throw new Error('MQTT profile host must be a hostname or IP address without scheme/path/userinfo.');
  }
  if (net.isIP(value)) return value;
  if (value.length > 253 || value.startsWith('.') || value.endsWith('.')) throw new Error('MQTT profile host is invalid.');
  const labels = value.split('.');
  if (labels.some(label => !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))) {
    throw new Error('MQTT profile host is invalid.');
  }
  return value;
}

export class MqttProfileStore {
  constructor(
    private readonly filename = mqttProfilesPath(),
    private readonly env: NodeJS.ProcessEnv = process.env
  ) {}

  async list(): Promise<Array<MqttProfile & { passwordConfigured: boolean }>> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filename, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    if (Buffer.byteLength(raw, 'utf8') > 64 * 1024) throw new Error('MQTT profile file exceeds 64 KiB.');
    const parsed = configSchema.parse(JSON.parse(raw));
    const seen = new Set<string>();
    return parsed.profiles.map(profile => {
      if (seen.has(profile.id)) throw new Error(`Duplicate MQTT profile id '${profile.id}'.`);
      seen.add(profile.id);
      const host = validateHost(profile.host);
      return {
        ...profile,
        host,
        passwordConfigured: Boolean(profile.passwordEnv && this.env[profile.passwordEnv])
      };
    });
  }

  async status() {
    const profiles = await this.list();
    return {
      configured: profiles.length > 0,
      profileCount: profiles.length,
      profiles: profiles.map(profile => ({
        id: profile.id,
        host: profile.host,
        port: profile.port,
        tls: profile.tls,
        usernameConfigured: Boolean(profile.username),
        passwordConfigured: profile.passwordConfigured,
      }))
    };
  }

  async resolve(id: string): Promise<ResolvedMqttProfile> {
    const selected = profileId.parse(id);
    const profiles = await this.list();
    const profile = profiles.find(item => item.id === selected);
    if (!profile) throw new Error(`MQTT profile '${selected}' is not configured in owner-local mqtt-profiles.json.`);
    const password = profile.passwordEnv ? this.env[profile.passwordEnv] : undefined;
    if (profile.passwordEnv && !password) {
      throw new Error(`MQTT profile '${selected}' references a password environment variable that is not available to the runtime.`);
    }
    if (password && !profile.username) throw new Error(`MQTT profile '${selected}' cannot use a password without a username.`);
    return {
      id: profile.id,
      host: profile.host,
      port: profile.port,
      tls: profile.tls,
      ...(profile.username ? { username: profile.username } : {}),
      ...(profile.passwordEnv ? { passwordEnv: profile.passwordEnv } : {}),
      ...(profile.servername ? { servername: profile.servername } : {}),
      ...(password ? { password } : {})
    };
  }
}
