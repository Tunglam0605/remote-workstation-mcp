import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod/v4';
import { setupConfigDir } from '../../setup/settings.js';

const presetId = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
const nodeId = z.string().min(1).max(64).regex(/^[A-Za-z0-9_.:-]+$/);
const inputName = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/);

const stringBinding = z.object({
  type: z.literal('string'),
  nodeId,
  input: inputName,
  required: z.boolean().default(false),
  default: z.string().max(4096).optional(),
  maxLength: z.number().int().min(1).max(16_384).default(4096)
}).strict();

const numberBinding = z.object({
  type: z.literal('number'),
  nodeId,
  input: inputName,
  required: z.boolean().default(false),
  default: z.number().finite().optional(),
  min: z.number().finite().optional(),
  max: z.number().finite().optional()
}).strict().superRefine((value, ctx) => {
  if (value.min !== undefined && value.max !== undefined && value.min > value.max) {
    ctx.addIssue({ code: 'custom', message: 'number binding min cannot exceed max' });
  }
  if (value.default !== undefined && value.min !== undefined && value.default < value.min) {
    ctx.addIssue({ code: 'custom', message: 'number binding default is below min' });
  }
  if (value.default !== undefined && value.max !== undefined && value.default > value.max) {
    ctx.addIssue({ code: 'custom', message: 'number binding default is above max' });
  }
});

const booleanBinding = z.object({
  type: z.literal('boolean'),
  nodeId,
  input: inputName,
  required: z.boolean().default(false),
  default: z.boolean().optional()
}).strict();

const binding = z.discriminatedUnion('type', [stringBinding, numberBinding, booleanBinding]);

const presetSchema = z.object({
  id: presetId,
  label: z.string().min(1).max(128).optional(),
  profileId: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  workflowFile: z.string().min(1).max(260),
  bindings: z.record(z.string().min(1).max(64).regex(/^[A-Za-z0-9_.-]+$/), binding).default({})
}).strict();

const configSchema = z.object({
  version: z.literal(1),
  presets: z.array(presetSchema).max(64)
}).strict();

export type ComfyUiPreset = z.infer<typeof presetSchema>;
export type ComfyUiBinding = z.infer<typeof binding>;

export function comfyUiPresetManifestPath(): string {
  return path.join(setupConfigDir(), 'comfyui-presets.json');
}

function safeWorkflowPath(filename: string): string {
  const value = filename.trim();
  if (!value || path.isAbsolute(value) || value.includes('\0')) {
    throw new Error('ComfyUI workflowFile must be a relative owner-local filename.');
  }
  const normalized = path.normalize(value);
  if (normalized === '..' || normalized.startsWith('..' + path.sep)) {
    throw new Error('ComfyUI workflowFile cannot escape the owner-local workflow directory.');
  }
  if (path.extname(normalized).toLowerCase() !== '.json') {
    throw new Error('ComfyUI workflowFile must use the .json extension.');
  }
  return normalized;
}

export class ComfyUiPresetStore {
  constructor(
    private readonly manifestPath = comfyUiPresetManifestPath(),
    private readonly workflowRoot = path.join(setupConfigDir(), 'comfyui-workflows')
  ) {}

  async list(): Promise<ComfyUiPreset[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.manifestPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    if (Buffer.byteLength(raw, 'utf8') > 256 * 1024) throw new Error('ComfyUI preset manifest exceeds 256 KiB.');
    const parsed = configSchema.parse(JSON.parse(raw));
    const seen = new Set<string>();
    return parsed.presets.map(preset => {
      if (seen.has(preset.id)) throw new Error(`Duplicate ComfyUI preset id '${preset.id}'.`);
      seen.add(preset.id);
      const bindingNames = Object.keys(preset.bindings);
      if (bindingNames.length > 64) throw new Error(`ComfyUI preset '${preset.id}' exposes more than 64 bindings.`);
      return { ...preset, workflowFile: safeWorkflowPath(preset.workflowFile) };
    });
  }

  async get(id: string): Promise<ComfyUiPreset> {
    const selected = presetId.parse(id);
    const preset = (await this.list()).find(item => item.id === selected);
    if (!preset) throw new Error(`ComfyUI preset '${selected}' is not configured.`);
    return preset;
  }

  async loadWorkflow(preset: ComfyUiPreset): Promise<Record<string, unknown>> {
    const root = await fs.realpath(this.workflowRoot);
    const candidate = path.resolve(root, preset.workflowFile);
    const relative = path.relative(root, candidate);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
      throw new Error('ComfyUI workflow path escaped owner-local workflow root.');
    }
    const raw = await fs.readFile(candidate, 'utf8');
    if (Buffer.byteLength(raw, 'utf8') > 2 * 1024 * 1024) throw new Error('ComfyUI workflow exceeds 2 MiB.');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('ComfyUI workflow JSON must be an object.');
    const entries = Object.entries(parsed as Record<string, unknown>);
    if (entries.length < 1 || entries.length > 512) throw new Error('ComfyUI workflow must contain 1..512 nodes.');
    for (const [key, value] of entries) {
      if (!/^[A-Za-z0-9_.:-]+$/.test(key)) throw new Error('ComfyUI workflow contains an invalid node id.');
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`ComfyUI workflow node '${key}' must be an object.`);
      const inputs = (value as Record<string, unknown>).inputs;
      if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) throw new Error(`ComfyUI workflow node '${key}' must contain an inputs object.`);
    }
    return parsed as Record<string, unknown>;
  }

  publicPreset(preset: ComfyUiPreset) {
    return {
      id: preset.id,
      label: preset.label,
      profileId: preset.profileId,
      bindings: Object.fromEntries(Object.entries(preset.bindings).map(([name, item]) => [name, {
        type: item.type,
        required: item.required,
        ...('default' in item && item.default !== undefined ? { default: item.default } : {}),
        ...(item.type === 'string' ? { maxLength: item.maxLength } : {}),
        ...(item.type === 'number' ? {
          ...(item.min !== undefined ? { min: item.min } : {}),
          ...(item.max !== undefined ? { max: item.max } : {})
        } : {})
      }]))
    };
  }
}
