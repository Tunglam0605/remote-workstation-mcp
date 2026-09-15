import os from 'node:os';
import type { PairingStore } from '../pairing/pairing-store.js';
import type { SshAdapter } from './ssh.js';

export interface DeviceDescriptor {
  id: string;
  name: string;
  transport: 'local' | 'ssh' | 'paired_ssh';
  platform?: string;
  arch?: string;
  hostname: string;
  user?: string;
  remoteRoot?: string;
  online?: boolean;
  latencyMs?: number;
  version?: string;
  capabilities?: string[];
  pairedAt?: string;
  lastSeenAt?: string;
}

type SshDeviceTransport = Pick<SshAdapter, 'listHosts' | 'probe' | 'execute'>;
type PairingInventory = Pick<PairingStore, 'listDevices' | 'getActiveDevice'>;

function localDeviceId(): string {
  const configured = process.env.RWMCP_DEVICE_ID?.trim();
  if (configured) return configured;
  return os.hostname().toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
}

export class DeviceRegistryAdapter {
  constructor(
    private readonly ssh: SshDeviceTransport,
    private readonly pairing?: PairingInventory
  ) {}

  async list(probe = true): Promise<DeviceDescriptor[]> {
    const local: DeviceDescriptor = {
      id: localDeviceId(),
      name: process.env.RWMCP_DEVICE_NAME?.trim() || os.hostname(),
      transport: 'local',
      platform: os.platform(),
      arch: os.arch(),
      hostname: os.hostname(),
      online: true,
      latencyMs: 0
    };

    const hosts = this.ssh.listHosts();
    const paired = this.pairing ? await this.pairing.listDevices() : [];
    const pairedHostIds = new Set(paired.map(device => device.bootstrapHostId).filter(Boolean));
    const unpairedHosts = hosts.filter(host => !pairedHostIds.has(host.id));

    const pairedDescriptors = await Promise.all(paired.map(async device => {
      const host = device.bootstrapHostId ? hosts.find(item => item.id === device.bootstrapHostId) : undefined;
      let online: boolean | undefined;
      let latencyMs: number | undefined;
      if (probe && host) {
        const status = await this.ssh.probe(host.id);
        online = status.reachable;
        latencyMs = status.durationMs;
      }
      return {
        id: device.id,
        name: device.name,
        transport: host ? 'paired_ssh' as const : 'paired_ssh' as const,
        platform: device.platform,
        arch: device.arch,
        hostname: device.hostname,
        user: host?.user,
        remoteRoot: host?.remoteRoot,
        online,
        latencyMs,
        version: device.version,
        capabilities: [...device.capabilities],
        pairedAt: device.pairedAt,
        lastSeenAt: device.lastSeenAt
      } satisfies DeviceDescriptor;
    }));

    if (!probe) {
      return [local, ...pairedDescriptors, ...unpairedHosts.map(host => ({
        id: host.id,
        name: host.name,
        transport: 'ssh' as const,
        hostname: host.hostname,
        user: host.user,
        remoteRoot: host.remoteRoot
      }))];
    }

    const remote = await Promise.all(unpairedHosts.map(async host => {
      const status = await this.ssh.probe(host.id);
      return {
        id: host.id,
        name: host.name,
        transport: 'ssh' as const,
        hostname: host.hostname,
        user: host.user,
        remoteRoot: host.remoteRoot,
        online: status.reachable,
        latencyMs: status.durationMs
      } satisfies DeviceDescriptor;
    }));
    return [local, ...pairedDescriptors, ...remote];
  }

  private remoteHostId(id: string): string {
    const host = this.ssh.listHosts().find(item => item.id === id);
    if (host) return host.id;
    if (id === localDeviceId()) {
      throw new Error(`Device '${id}' is local. Use the normal workspace/process tools for local execution.`);
    }
    throw new Error(`Device '${id}' is not registered by the local owner.`);
  }

  private async routeRemote(id: string): Promise<{ hostId: string; transport: 'ssh' | 'paired_ssh' }> {
    const direct = this.ssh.listHosts().find(item => item.id === id);
    if (direct) return { hostId: direct.id, transport: 'ssh' };
    if (id === localDeviceId()) {
      throw new Error(`Device '${id}' is local. Use the normal workspace/process tools for local execution.`);
    }
    const paired = this.pairing ? await this.pairing.getActiveDevice(id) : undefined;
    if (paired?.bootstrapHostId) {
      const host = this.ssh.listHosts().find(item => item.id === paired.bootstrapHostId);
      if (!host) throw new Error(`Paired device '${id}' has no active bootstrap transport.`);
      return { hostId: host.id, transport: 'paired_ssh' };
    }
    throw new Error(`Device '${id}' is not registered by the local owner.`);
  }

  async probe(id: string) {
    if (id === localDeviceId()) {
      return { device: id, transport: 'local' as const, reachable: true, hostname: os.hostname(), platform: os.platform(), durationMs: 0 };
    }
    const route = await this.routeRemote(id);
    const result = await this.ssh.probe(route.hostId);
    return { device: id, transport: route.transport, routedVia: route.hostId, ...result };
  }

  async execute(id: string, program: string, args: string[] = [], cwd = '.', timeoutMs?: number) {
    const route = await this.routeRemote(id);
    const result = await this.ssh.execute(route.hostId, program, args, cwd, timeoutMs);
    return { device: id, transport: route.transport, routedVia: route.hostId, ...result };
  }
}
