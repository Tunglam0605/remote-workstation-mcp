import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import * as z from 'zod/v4';
import type { PolicyConfig } from './model.js';

const multiNodeGrantSchema = z.object({
  id: z.string().min(1).max(96).regex(/^[A-Za-z0-9._-]+$/),
  enabled: z.boolean().default(true),
  sourceNodeId: z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/),
  destinationNodeId: z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/),
  sourceWorkspace: z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/),
  destinationWorkspace: z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/),
  sourcePathPrefixes: z.array(z.string().min(1).max(1024)).min(1).max(32),
  destinationBasePaths: z.array(z.string().min(1).max(1024)).min(1).max(32),
  allowedExtensions: z.array(z.string().regex(/^\.[A-Za-z0-9]{1,16}$/)).min(1).max(64),
  maxBytes: z.number().int().positive().max(512 * 1024 * 1024),
  transports: z.array(z.enum(['direct', 'relay'])).min(1).max(2)
});

const taskSchema = z.object({
  program: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().default('.')
});

const lspServerSchema = z.object({
  program: z.string().min(1),
  args: z.array(z.string()).default([]),
  languages: z.record(z.string().min(1), z.string().min(1)).default({}),
  initializationOptions: z.record(z.string(), z.unknown()).optional()
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
    maxRuntimeMs: z.number().int().positive().max(24 * 60 * 60 * 1000).default(10 * 60 * 1000),
    maxInputBytes: z.number().int().positive().max(1024 * 1024).default(64 * 1024)
  }).default({ allowExecutables: [], inheritEnv: ['PATH', 'HOME', 'LANG', 'TERM', 'TMPDIR', 'TMP', 'TEMP'], maxOutputBytes: 256 * 1024, maxRuntimeMs: 600000, maxInputBytes: 64 * 1024 }),
  tasks: z.record(z.string().regex(/^[A-Za-z0-9._-]+$/), taskSchema).default({}),
  lsp: z.object({
    servers: z.record(z.string().regex(/^[A-Za-z0-9._-]+$/), lspServerSchema).default({}),
    requestTimeoutMs: z.number().int().positive().max(60_000).default(10_000),
    maxMessageBytes: z.number().int().positive().max(16 * 1024 * 1024).default(2 * 1024 * 1024),
    diagnosticsSettleMs: z.number().int().min(0).max(5_000).default(250)
  }).default({ servers: {}, requestTimeoutMs: 10_000, maxMessageBytes: 2 * 1024 * 1024, diagnosticsSettleMs: 250 }),
  fullControl: z.object({
    allowRawShell: z.boolean().default(false),
    allowHostFilesystem: z.boolean().default(false)
  }).default({ allowRawShell: false, allowHostFilesystem: false }),
  privileged: z.object({
    allowSudo: z.boolean().default(false),
    maxRuntimeMs: z.number().int().positive().max(60 * 60 * 1000).default(10 * 60 * 1000)
  }).default({ allowSudo: false, maxRuntimeMs: 600000 }),
  engineering: z.object({
    enabled: z.boolean().default(true),
    maxCommandRuntimeMs: z.number().int().positive().max(60 * 60 * 1000).default(10 * 60 * 1000),
    allowHardwareMutationInWorkspace: z.boolean().default(false),
    allowSerialWriteInWorkspace: z.boolean().default(false)
  }).default({ enabled: true, maxCommandRuntimeMs: 600000, allowHardwareMutationInWorkspace: false, allowSerialWriteInWorkspace: false }),
  multiNode: z.object({
    enabled: z.boolean().default(false),
    controllerPrincipalId: z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/).default('openai-tunnel'),
    controllerPrincipalType: z.string().min(1).max(128).default('openai-secure-mcp-tunnel'),
    grants: z.array(multiNodeGrantSchema).max(256).default([])
  }).default({
    enabled: false,
    controllerPrincipalId: 'openai-tunnel',
    controllerPrincipalType: 'openai-secure-mcp-tunnel',
    grants: []
  }),
  legacyRemoteControl: z.object({
    enabled: z.boolean().default(false)
  }).default({ enabled: false })
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
