import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setupConfigDir, type SetupPathOptions } from '../setup/settings.js';

export const PAIRING_STORE_VERSION = 1 as const;
export const DEFAULT_PAIRING_TTL_SECONDS = 10 * 60;
const MAX_PAIRING_TTL_SECONDS = 60 * 60;
const MAX_PENDING_CODES = 100;

export interface PendingPairing {
  id: string;
  codeHash: string;
  createdAt: string;
  expiresAt: string;
  claimedAt?: string;
  deviceId?: string;
  requestedName?: string;
  bootstrapHostId?: string;
}

export interface PairedDeviceRecord {
  id: string;
  name: string;
  hostname: string;
  platform: string;
  arch?: string;
  version: string;
  capabilities: string[];
  bootstrapTransport: 'ssh' | 'manual';
  bootstrapHostId?: string;
  credentialHash: string;
  credentialIssuedAt: string;
  pairedAt: string;
  lastSeenAt?: string;
  revokedAt?: string;
}

interface PairingState {
  version: 1;
  pending: PendingPairing[];
  devices: PairedDeviceRecord[];
}

export interface PairingRegistration {
  deviceId?: string;
  name: string;
  hostname: string;
  platform: string;
  arch?: string;
  version: string;
  capabilities?: string[];
  bootstrapTransport: 'ssh' | 'manual';
  bootstrapHostId?: string;
}

export interface PairingClaimResult {
  device: Omit<PairedDeviceRecord, 'credentialHash'>;
  credential: string;
}

export function pairingStorePath(options: SetupPathOptions = {}): string {
  return path.join(setupConfigDir(options), 'pairing', 'devices.json');
}

function iso(now: Date): string {
  return now.toISOString();
}

function hashSecret(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function publicDevice(device: PairedDeviceRecord): Omit<PairedDeviceRecord, 'credentialHash'> {
  const { credentialHash: _credentialHash, ...safe } = device;
  return safe;
}

function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}

function validateDeviceId(id: string): string {
  const value = id.trim();
  if (!/^[A-Za-z0-9._-]{3,128}$/.test(value)) {
    throw new Error('deviceId must contain only letters, numbers, dot, underscore or dash.');
  }
  return value;
}

function validateState(value: unknown): PairingState {
  if (!value || typeof value !== 'object') throw new Error('Pairing store is not a JSON object.');
  const raw = value as Partial<PairingState>;
  if (raw.version !== PAIRING_STORE_VERSION || !Array.isArray(raw.pending) || !Array.isArray(raw.devices)) {
    throw new Error('Unsupported or invalid pairing store format.');
  }
  return raw as PairingState;
}

export class PairingStore {
  private mutation: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly file = pairingStorePath(),
    private readonly now: () => Date = () => new Date()
  ) {}

  private async read(): Promise<PairingState> {
    try {
      const text = await fs.readFile(this.file, 'utf8');
      return validateState(JSON.parse(text.replace(/^\uFEFF/, '')) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: PAIRING_STORE_VERSION, pending: [], devices: [] };
      }
      throw error;
    }
  }

  private async write(state: PairingState): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temp, this.file);
    if (process.platform !== 'win32') await fs.chmod(this.file, 0o600);
  }

  private async mutate<T>(fn: (state: PairingState) => Promise<T> | T): Promise<T> {
    let resolveGate!: () => void;
    const previous = this.mutation;
    this.mutation = new Promise<void>(resolve => { resolveGate = resolve; });
    await previous;
    try {
      const state = await this.read();
      const result = await fn(state);
      await this.write(state);
      return result;
    } finally {
      resolveGate();
    }
  }

  private prunePending(state: PairingState): void {
    const cutoff = this.now().getTime() - (24 * 60 * 60 * 1000);
    state.pending = state.pending
      .filter(item => !item.claimedAt || new Date(item.claimedAt).getTime() >= cutoff)
      .slice(-MAX_PENDING_CODES);
  }

  async createCode(input: { requestedName?: string; bootstrapHostId?: string; ttlSeconds?: number } = {}) {
    const ttlSeconds = Math.min(Math.max(input.ttlSeconds ?? DEFAULT_PAIRING_TTL_SECONDS, 60), MAX_PAIRING_TTL_SECONDS);
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + ttlSeconds * 1000);
    const raw = crypto.randomBytes(10).toString('hex').toUpperCase();
    const groups = raw.match(/.{1,4}/g) ?? [raw];
    const code = `RWMCP-${groups.join('-')}`;
    const entry: PendingPairing = {
      id: crypto.randomUUID(),
      codeHash: hashSecret(normalizeCode(code)),
      createdAt: iso(createdAt),
      expiresAt: iso(expiresAt),
      requestedName: input.requestedName?.trim() || undefined,
      bootstrapHostId: input.bootstrapHostId?.trim() || undefined
    };
    await this.mutate(state => {
      this.prunePending(state);
      state.pending.push(entry);
    });
    return {
      pairingId: entry.id,
      code,
      createdAt: entry.createdAt,
      expiresAt: entry.expiresAt,
      requestedName: entry.requestedName,
      bootstrapHostId: entry.bootstrapHostId
    };
  }

  async inspectCode(code: string): Promise<Omit<PendingPairing, 'codeHash'>> {
    const state = await this.read();
    const digest = hashSecret(normalizeCode(code));
    const entry = state.pending.find(item => item.codeHash === digest);
    if (!entry) throw new Error('Pairing code is invalid.');
    if (entry.claimedAt) throw new Error('Pairing code has already been used.');
    if (new Date(entry.expiresAt).getTime() <= this.now().getTime()) throw new Error('Pairing code has expired.');
    const { codeHash: _codeHash, ...safe } = entry;
    return safe;
  }

  async claim(
    code: string,
    registration: PairingRegistration,
    material?: { deviceId?: string; credential?: string }
  ): Promise<PairingClaimResult> {
    const normalizedCode = normalizeCode(code);
    const digest = hashSecret(normalizedCode);
    const now = this.now();
    const deviceId = validateDeviceId(material?.deviceId ?? `dev_${crypto.randomBytes(12).toString('hex')}`);
    const credential = material?.credential ?? `rwmcp_dev_${crypto.randomBytes(32).toString('base64url')}`;
    if (!/^rwmcp_dev_[A-Za-z0-9_-]{32,}$/.test(credential)) throw new Error('Generated device credential has an invalid format.');

    return await this.mutate(state => {
      this.prunePending(state);
      const entry = state.pending.find(item => item.codeHash === digest);
      if (!entry) throw new Error('Pairing code is invalid.');
      if (entry.claimedAt) throw new Error('Pairing code has already been used.');
      if (new Date(entry.expiresAt).getTime() <= now.getTime()) throw new Error('Pairing code has expired.');
      if (entry.bootstrapHostId && registration.bootstrapHostId && entry.bootstrapHostId !== registration.bootstrapHostId) {
        throw new Error('Pairing code is bound to a different bootstrap host.');
      }
      if (state.devices.some(device => device.id === deviceId && !device.revokedAt)) {
        throw new Error(`Device id '${deviceId}' is already paired.`);
      }
      const device: PairedDeviceRecord = {
        id: deviceId,
        name: registration.name.trim() || entry.requestedName || registration.hostname,
        hostname: registration.hostname.trim(),
        platform: registration.platform.trim(),
        arch: registration.arch?.trim() || undefined,
        version: registration.version.trim(),
        capabilities: [...new Set(registration.capabilities ?? [])].sort(),
        bootstrapTransport: registration.bootstrapTransport,
        bootstrapHostId: registration.bootstrapHostId?.trim() || entry.bootstrapHostId,
        credentialHash: hashSecret(credential),
        credentialIssuedAt: iso(now),
        pairedAt: iso(now),
        lastSeenAt: iso(now)
      };
      state.devices.push(device);
      entry.claimedAt = iso(now);
      entry.deviceId = device.id;
      return { device: publicDevice(device), credential };
    });
  }

  async listDevices(options: { includeRevoked?: boolean } = {}) {
    const state = await this.read();
    return state.devices
      .filter(device => options.includeRevoked === true || !device.revokedAt)
      .map(publicDevice);
  }

  async listPending() {
    const state = await this.read();
    const now = this.now().getTime();
    return state.pending
      .filter(item => !item.claimedAt && new Date(item.expiresAt).getTime() > now)
      .map(({ codeHash: _codeHash, ...safe }) => safe);
  }

  async getActiveDevice(id: string) {
    const state = await this.read();
    const device = state.devices.find(item => item.id === id && !item.revokedAt);
    return device ? publicDevice(device) : undefined;
  }

  async verifyCredential(deviceId: string, credential: string): Promise<boolean> {
    const state = await this.read();
    const device = state.devices.find(item => item.id === deviceId && !item.revokedAt);
    if (!device) return false;
    const expected = Buffer.from(device.credentialHash, 'hex');
    const actual = Buffer.from(hashSecret(credential), 'hex');
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  }

  async touch(deviceId: string, patch: Partial<Pick<PairingRegistration, 'name' | 'hostname' | 'platform' | 'arch' | 'version' | 'capabilities'>> = {}) {
    const now = this.now();
    return await this.mutate(state => {
      const device = state.devices.find(item => item.id === deviceId && !item.revokedAt);
      if (!device) throw new Error(`Paired device '${deviceId}' is not active.`);
      if (patch.name?.trim()) device.name = patch.name.trim();
      if (patch.hostname?.trim()) device.hostname = patch.hostname.trim();
      if (patch.platform?.trim()) device.platform = patch.platform.trim();
      if (patch.arch?.trim()) device.arch = patch.arch.trim();
      if (patch.version?.trim()) device.version = patch.version.trim();
      if (patch.capabilities) device.capabilities = [...new Set(patch.capabilities)].sort();
      device.lastSeenAt = iso(now);
      return publicDevice(device);
    });
  }

  async revoke(deviceId: string) {
    const now = this.now();
    return await this.mutate(state => {
      const device = state.devices.find(item => item.id === deviceId && !item.revokedAt);
      if (!device) throw new Error(`Paired device '${deviceId}' is not active.`);
      device.revokedAt = iso(now);
      return publicDevice(device);
    });
  }
}
