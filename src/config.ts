import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import * as z from 'zod/v4';
import type { PolicyConfig } from './model.js';

const taskSchema = z.object({
  program: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().default('.')
});

const schema = z.object({
  version: z.literal(1),
  mode: z.enum(['read_only', 'workspace', 'elevated', 'full_control']).default('workspace'),
  workspaces: z.array(z.object({
    id: z.string().min(1).regex(/^[A-Za-z0-9._-]+$/),
    name: z.string().optional(),
    root: z.string().min(1),
    readOnly: z.boolean().optional().default(false)
  })).min(1),
  filesystem: z.object({
    maxReadBytes: z.number().int().positive().max(16 * 1024 * 1024).default(1024 * 1024),
    maxWriteBytes: z.number().int().positive().max(16 * 1024 * 1024).default(1024 * 1024)
  }).default({ maxReadBytes: 1024 * 1024, maxWriteBytes: 1024 * 1024 }),
  search: z.object({
    maxResults: z.number().int().positive().max(1000).default(100),
    maxFiles: z.number().int().positive().max(100000).default(5000),
    maxFileBytes: z.number().int().positive().max(16 * 1024 * 1024).default(1024 * 1024)
  }).default({ maxResults: 100, maxFiles: 5000, maxFileBytes: 1024 * 1024 }),
  process: z.object({
    allowExecutables: z.array(z.string().min(1)).default([]),
    inheritEnv: z.array(z.string().min(1)).default(['PATH', 'HOME', 'LANG', 'TERM', 'TMPDIR', 'TMP', 'TEMP']),
    maxOutputBytes: z.number().int().positive().max(4 * 1024 * 1024).default(256 * 1024),
    maxRuntimeMs: z.number().int().positive().max(24 * 60 * 60 * 1000).default(10 * 60 * 1000)
  }).default({ allowExecutables: [], inheritEnv: ['PATH', 'HOME', 'LANG', 'TERM', 'TMPDIR', 'TMP', 'TEMP'], maxOutputBytes: 256 * 1024, maxRuntimeMs: 600000 }),
  tasks: z.record(z.string().regex(/^[A-Za-z0-9._-]+$/), taskSchema).default({})
});

function expandHome(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

export async function loadPolicy(policyPath?: string): Promise<PolicyConfig> {
  const selected = path.resolve(policyPath ?? process.env.RWMCP_POLICY ?? 'config/policy.yaml');
  let raw: string;
  try {
    raw = await fs.readFile(selected, 'utf8');
  } catch (error) {
    throw new Error(`Policy file not found: ${selected}. Copy config/policy.example.yaml to config/policy.yaml and edit it.`, { cause: error });
  }
  const parsed = schema.parse(YAML.parse(raw));
  return {
    ...parsed,
    workspaces: parsed.workspaces.map(ws => ({ ...ws, root: path.resolve(expandHome(ws.root)) }))
  } as PolicyConfig;
}
