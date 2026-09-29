import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod/v4';
import { setupConfigDir } from '../../setup/settings.js';

const presetId = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
const keyName = z.string().min(1).max(64).regex(/^[A-Za-z0-9_.-]+$/);

const stringBinding = z.object({
  type: z.literal('string'),
  required: z.boolean().default(false),
  default: z.string().max(4096).optional(),
  maxLength: z.number().int().min(1).max(16_384).default(4096)
}).strict();

const numberBinding = z.object({
  type: z.literal('number'),
  required: z.boolean().default(false),
  default: z.number().finite().optional(),
  min: z.number().finite().optional(),
  max: z.number().finite().optional()
}).strict().superRefine((value, ctx) => {
  if (value.min !== undefined && value.max !== undefined && value.min > value.max) {
    ctx.addIssue({ code: 'custom', message: 'number binding min cannot exceed max' });
  }
});

const booleanBinding = z.object({
  type: z.literal('boolean'),
  required: z.boolean().default(false),
  default: z.boolean().optional()
}).strict();

const binding = z.discriminatedUnion('type', [stringBinding, numberBinding, booleanBinding]);

const presetSchema = z.object({
  id: presetId,
  label: z.string().min(1).max(128).optional(),
  entryPoint: z.string().min(1).max(512),
  compositionId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/),
  crf: z.number().int().min(0).max(51).default(20),
  concurrency: z.number().int().min(1).max(8).default(4),
  x264Preset: z.enum(['superfast','veryfast','faster','fast','medium','slow','slower','veryslow']).default('medium'),
  bindings: z.record(keyName, binding).default({})
}).strict();

const configSchema = z.object({
  version: z.literal(1),
  presets: z.array(presetSchema).max(64)
}).strict();

export type RemotionPreset = z.infer<typeof presetSchema>;
export type RemotionBinding = z.infer<typeof binding>;

export function remotionPresetManifestPath(): string {
  return path.join(setupConfigDir(), 'remotion-presets.json');
}

function safeRelativeFile(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || path.isAbsolute(trimmed) || trimmed.includes('\0')) {
    throw new Error('Remotion entryPoint must be a project-relative path.');
  }
  const normalized = path.normalize(trimmed);
  if (normalized === '..' || normalized.startsWith('..' + path.sep)) {
    throw new Error('Remotion entryPoint cannot escape the selected project.');
  }
  const ext = path.extname(normalized).toLowerCase();
  if (!['.js','.jsx','.ts','.tsx'].includes(ext)) {
    throw new Error('Remotion entryPoint must use .js, .jsx, .ts or .tsx.');
  }
  return normalized;
}

export class RemotionPresetStore {
  constructor(private readonly filename = remotionPresetManifestPath()) {}

  async list(): Promise<RemotionPreset[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filename, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    if (Buffer.byteLength(raw, 'utf8') > 256 * 1024) throw new Error('Remotion preset manifest exceeds 256 KiB.');
    const parsed = configSchema.parse(JSON.parse(raw));
    const seen = new Set<string>();
    return parsed.presets.map(preset => {
      if (seen.has(preset.id)) throw new Error(`Duplicate Remotion preset id '${preset.id}'.`);
      seen.add(preset.id);
      if (Object.keys(preset.bindings).length > 64) throw new Error(`Remotion preset '${preset.id}' exposes more than 64 bindings.`);
      return { ...preset, entryPoint: safeRelativeFile(preset.entryPoint) };
    });
  }

  async get(id: string): Promise<RemotionPreset> {
    const selected = presetId.parse(id);
    const preset = (await this.list()).find(item => item.id === selected);
    if (!preset) throw new Error(`Remotion preset '${selected}' is not configured.`);
    return preset;
  }

  publicPreset(preset: RemotionPreset) {
    return {
      id: preset.id,
      label: preset.label,
      compositionId: preset.compositionId,
      crf: preset.crf,
      concurrency: preset.concurrency,
      x264Preset: preset.x264Preset,
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

export function resolveRemotionParameters(
  preset: RemotionPreset,
  overrides: Record<string, string | number | boolean>
): Record<string, string | number | boolean> {
  if (Object.keys(overrides).length > 64) throw new Error('Remotion parameter overrides are limited to 64 entries.');
  for (const key of Object.keys(overrides)) {
    if (!(key in preset.bindings)) throw new Error(`Remotion parameter '${key}' is not exposed by preset '${preset.id}'.`);
  }
  const out: Record<string, string | number | boolean> = {};
  for (const [name, bindingDef] of Object.entries(preset.bindings)) {
    const supplied = overrides[name];
    const value = supplied !== undefined ? supplied : ('default' in bindingDef ? bindingDef.default : undefined);
    if (value === undefined) {
      if (bindingDef.required) throw new Error(`Remotion parameter '${name}' is required.`);
      continue;
    }
    if (bindingDef.type === 'string') {
      if (typeof value !== 'string') throw new Error(`Remotion parameter '${name}' must be a string.`);
      if (value.length > bindingDef.maxLength) throw new Error(`Remotion parameter '${name}' exceeds maxLength.`);
      out[name] = value;
    } else if (bindingDef.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Remotion parameter '${name}' must be a finite number.`);
      if (bindingDef.min !== undefined && value < bindingDef.min) throw new Error(`Remotion parameter '${name}' is below min.`);
      if (bindingDef.max !== undefined && value > bindingDef.max) throw new Error(`Remotion parameter '${name}' exceeds max.`);
      out[name] = value;
    } else {
      if (typeof value !== 'boolean') throw new Error(`Remotion parameter '${name}' must be boolean.`);
      out[name] = value;
    }
  }
  return out;
}
