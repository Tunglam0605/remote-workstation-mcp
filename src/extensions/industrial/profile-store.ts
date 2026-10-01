import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod/v4';
import { setupConfigDir } from '../../setup/settings.js';
import { validateTopicFilter } from '../mqtt/mqtt-client.js';

const profileId = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
const label = z.string().min(1).max(128).optional();

const modbusRtuProfile = z.object({
  id: profileId,
  label,
  kind: z.literal('modbus-rtu'),
  port: z.string().min(1).max(260),
  unitId: z.number().int().min(1).max(247),
  baudRate: z.number().int().min(300).max(12_000_000).default(9600),
  dataBits: z.union([z.literal(7), z.literal(8)]).default(8),
  parity: z.union([z.literal('none'), z.literal('even'), z.literal('odd')]).default('even'),
  stopBits: z.union([z.literal(1), z.literal(2)]).default(1),
  function: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).default(3),
  address: z.number().int().min(0).max(65_535).default(0)
}).strict();

const modbusTcpProfile = z.object({
  id: profileId,
  label,
  kind: z.literal('modbus-tcp'),
  host: z.string().min(1).max(253),
  port: z.number().int().min(1).max(65_535).default(502),
  unitId: z.number().int().min(0).max(255),
  function: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).default(3),
  address: z.number().int().min(0).max(65_535).default(0)
}).strict();

const opcuaProfile = z.object({
  id: profileId,
  label,
  kind: z.literal('opcua'),
  endpointUrl: z.string().min(1).max(1024),
  rootNodeId: z.string().min(1).max(512).default('RootFolder')
}).strict();

const mqttTopicProfile = z.object({
  id: profileId,
  label,
  kind: z.literal('mqtt-topic'),
  mqttProfileId: profileId,
  topicFilter: z.string().min(1).max(512)
}).strict();

const industrialProfile = z.discriminatedUnion('kind', [
  modbusRtuProfile,
  modbusTcpProfile,
  opcuaProfile,
  mqttTopicProfile
]);

const configSchema = z.object({
  version: z.literal(1),
  profiles: z.array(industrialProfile).max(64)
}).strict();

export type IndustrialProfile = z.infer<typeof industrialProfile>;

export function industrialProfilesPath(): string {
  return path.join(setupConfigDir(), 'industrial-endpoints.json');
}

export class IndustrialProfileStore {
  constructor(private readonly filename = industrialProfilesPath()) {}

  async list(): Promise<IndustrialProfile[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filename, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    if (Buffer.byteLength(raw, 'utf8') > 128 * 1024) throw new Error('Industrial endpoint profile file exceeds 128 KiB.');
    const parsed = configSchema.parse(JSON.parse(raw));
    const seen = new Set<string>();
    return parsed.profiles.map(profile => {
      if (seen.has(profile.id)) throw new Error(`Duplicate industrial profile id '${profile.id}'.`);
      seen.add(profile.id);
      if (profile.kind === 'mqtt-topic') {
        return { ...profile, topicFilter: validateTopicFilter(profile.topicFilter) };
      }
      return profile;
    });
  }

  async get(id: string): Promise<IndustrialProfile> {
    const selected = profileId.parse(id);
    const profile = (await this.list()).find(item => item.id === selected);
    if (!profile) throw new Error(`Industrial profile '${selected}' is not configured.`);
    return profile;
  }

  async status() {
    const profiles = await this.list();
    const byKind = profiles.reduce<Record<string, number>>((acc, profile) => {
      acc[profile.kind] = (acc[profile.kind] ?? 0) + 1;
      return acc;
    }, {});
    return {
      configured: profiles.length > 0,
      profileCount: profiles.length,
      byKind
    };
  }
}
