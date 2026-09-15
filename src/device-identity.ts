import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setupConfigDir, type SetupPathOptions } from './setup/settings.js';

export interface DeviceIdentity {
  version: 1;
  id: string;
  name: string;
  hostname: string;
  platform: NodeJS.Platform;
  arch: string;
  createdAt: string;
}

export function deviceIdentityPath(options: SetupPathOptions = {}): string {
  return path.join(setupConfigDir(options), 'device-identity.json');
}

function normalizeName(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return (trimmed || fallback).slice(0, 128);
}

export async function loadOrCreateDeviceIdentity(
  options: SetupPathOptions = {},
  env: NodeJS.ProcessEnv = process.env
): Promise<DeviceIdentity> {
  const file = deviceIdentityPath(options);
  try {
    const raw = JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '')) as Partial<DeviceIdentity>;
    if (raw.version !== 1 || !raw.id || !/^[A-Za-z0-9._-]{1,128}$/.test(raw.id)) {
      throw new Error(`Invalid device identity at ${file}.`);
    }
    const hostname = raw.hostname || os.hostname();
    return {
      version: 1,
      id: raw.id,
      name: normalizeName(env.RWMCP_DEVICE_NAME ?? raw.name, hostname),
      hostname,
      platform: (raw.platform ?? os.platform()) as NodeJS.Platform,
      arch: raw.arch || os.arch(),
      createdAt: raw.createdAt || new Date(0).toISOString()
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const hostname = os.hostname();
  const configuredId = env.RWMCP_DEVICE_ID?.trim();
  const identity: DeviceIdentity = {
    version: 1,
    id: configuredId && /^[A-Za-z0-9._-]{1,128}$/.test(configuredId)
      ? configuredId
      : `dev_${randomBytes(12).toString('hex')}`,
    name: normalizeName(env.RWMCP_DEVICE_NAME, hostname),
    hostname,
    platform: os.platform(),
    arch: os.arch(),
    createdAt: new Date().toISOString()
  };

  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(identity, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temp, file);
  if ((options.platform ?? process.platform) !== 'win32') await fs.chmod(file, 0o600);
  return identity;
}

export function recommendedChatGptAppName(identity: Pick<DeviceIdentity, 'name' | 'hostname'>): string {
  const base = identity.name.trim() || identity.hostname.trim() || 'Workstation';
  return `Remote Workstation - ${base}`.slice(0, 96);
}
