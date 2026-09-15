import os from 'node:os';
import type { SshAdapter } from './ssh.js';

export interface DeviceDescriptor {
  id: string;
  name: string;
  transport: 'local' | 'ssh';
  platform?: string;
  hostname: string;
  user?: string;
  remoteRoot?: string;
  online?: boolean;
  latencyMs?: number;
}

type SshDeviceTransport = Pick<SshAdapter, 'listHosts' | 'probe' | 'execute'>;

function localDeviceId(): string {
  const configured = process.env.RWMCP_DEVICE_ID?.trim();
  if (configured) return configured;
  return os.hostname().toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
}

export class DeviceRegistryAdapter {
  constructor(private readonly ssh: SshDeviceTransport) {}

  async list(probe = true): Promise<DeviceDescriptor[]> {
    const local: DeviceDescriptor = {
      id: localDeviceId(),
      name: process.env.RWMCP_DEVICE_NAME?.trim() || os.hostname(),
      transport: 'local',
      platform: os.platform(),
      hostname: os.hostname(),
      online: true,
      latencyMs: 0
    };

    const hosts = this.ssh.listHosts();
    if (!probe) {
      return [local, ...hosts.map(host => ({
        id: host.id,
        name: host.name,
        transport: 'ssh' as const,
        hostname: host.hostname,
        user: host.user,
        remoteRoot: host.remoteRoot
      }))];
    }

    const remote = await Promise.all(hosts.map(async host => {
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
      };
    }));
    return [local, ...remote];
  }

  private remote(id: string) {
    const host = this.ssh.listHosts().find(item => item.id === id);
    if (!host) {
      if (id === localDeviceId()) {
        throw new Error(`Device '${id}' is local. Use the normal workspace/process tools for local execution.`);
      }
      throw new Error(`Device '${id}' is not registered by the local owner.`);
    }
    return host;
  }

  async probe(id: string) {
    if (id === localDeviceId()) {
      return { device: id, transport: 'local' as const, reachable: true, hostname: os.hostname(), platform: os.platform(), durationMs: 0 };
    }
    this.remote(id);
    const result = await this.ssh.probe(id);
    return { device: id, transport: 'ssh' as const, ...result };
  }

  async execute(id: string, program: string, args: string[] = [], cwd = '.', timeoutMs?: number) {
    this.remote(id);
    const result = await this.ssh.execute(id, program, args, cwd, timeoutMs);
    return { device: id, transport: 'ssh' as const, ...result };
  }
}
