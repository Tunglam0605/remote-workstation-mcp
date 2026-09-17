import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import * as z from 'zod/v4';
import type { HostsConfig } from './model.js';

const hostSchema = z.object({
  id: z.string().min(1).regex(/^[A-Za-z0-9._-]+$/),
  name: z.string().optional(),
  hostname: z.string().min(1).refine(value => !value.startsWith('-'), 'hostname must not start with -'),
  port: z.number().int().min(1).max(65535).default(22),
  user: z.string().min(1).refine(value => !value.startsWith('-'), 'user must not start with -'),
  auth: z.enum(['agent', 'identity_file']).default('agent'),
  identityFile: z.string().optional(),
  strictHostKeyChecking: z.enum(['yes', 'accept-new']).default('yes'),
  remoteShell: z.enum(['posix', 'windows-powershell']).default('posix'),
  remoteRoot: z.string().optional(),
  allowPrograms: z.array(z.string().min(1)).default([]),
  maxRuntimeMs: z.number().int().positive().max(60 * 60 * 1000).default(10 * 60 * 1000)
}).superRefine((host, ctx) => {
  if (host.auth === 'identity_file' && !host.identityFile) {
    ctx.addIssue({ code: 'custom', message: 'identityFile is required when auth=identity_file', path: ['identityFile'] });
  }
});

const schema = z.object({
  version: z.literal(1),
  hosts: z.array(hostSchema).default([])
});

function expandHome(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

export async function loadHosts(hostsPath?: string): Promise<HostsConfig> {
  const selected = path.resolve(hostsPath ?? process.env.RWMCP_HOSTS ?? 'config/hosts.yaml');
  try {
    const raw = await fs.readFile(selected, 'utf8');
    const parsed = schema.parse(YAML.parse(raw));
    const ids = new Set<string>();
    for (const host of parsed.hosts) {
      if (ids.has(host.id)) throw new Error(`Duplicate SSH host id '${host.id}'.`);
      ids.add(host.id);
    }
    return {
      version: 1,
      hosts: parsed.hosts.map(host => ({
        ...host,
        identityFile: host.identityFile ? path.resolve(expandHome(host.identityFile)) : undefined
      }))
    } as HostsConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, hosts: [] };
    throw error;
  }
}
