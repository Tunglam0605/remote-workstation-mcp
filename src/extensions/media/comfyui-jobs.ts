import type { MediaProfileStore } from './profile-store.js';
import { ComfyUiPresetStore, type ComfyUiBinding, type ComfyUiPreset } from './workflow-store.js';

export type ComfyUiParameterValue = string | number | boolean;
export type ComfyUiParameters = Record<string, ComfyUiParameterValue>;

function boundedString(value: unknown, max = 256): string | undefined {
  if (typeof value !== 'string') return undefined;
  const out = value.trim().replace(/\s+/g, ' ');
  return out ? out.slice(0, max) : undefined;
}

function endpoint(profile: { scheme: 'http'; host: string; port: number }): string {
  const host = profile.host.includes(':') ? `[${profile.host}]` : profile.host;
  return `${profile.scheme}://${host}:${profile.port}`;
}

async function requestJson(
  url: string,
  options: { method?: 'GET' | 'POST'; body?: unknown; timeoutMs: number; maxBytes?: number }
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetch(url, {
      method: options.method ?? 'GET',
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'user-agent': 'RemoteWorkstationMCP/0.66'
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {})
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
    if (bytes.length > maxBytes) throw new Error('ComfyUI response exceeded safety bound.');
    if (!response.ok) {
      const message = bytes.toString('utf8').replace(/\s+/g, ' ').slice(0, 512);
      throw new Error(`ComfyUI HTTP ${response.status}: ${message || response.statusText}`);
    }
    if (!bytes.length) return {};
    return JSON.parse(bytes.toString('utf8'));
  } finally {
    clearTimeout(timer);
  }
}

function validateParameter(binding: ComfyUiBinding, value: unknown, name: string): ComfyUiParameterValue {
  if (binding.type === 'string') {
    if (typeof value !== 'string') throw new Error(`ComfyUI parameter '${name}' must be a string.`);
    if (value.includes('\0')) throw new Error(`ComfyUI parameter '${name}' cannot contain NUL.`);
    if (value.length > binding.maxLength) throw new Error(`ComfyUI parameter '${name}' exceeds maxLength ${binding.maxLength}.`);
    return value;
  }
  if (binding.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`ComfyUI parameter '${name}' must be a finite number.`);
    if (binding.min !== undefined && value < binding.min) throw new Error(`ComfyUI parameter '${name}' is below minimum ${binding.min}.`);
    if (binding.max !== undefined && value > binding.max) throw new Error(`ComfyUI parameter '${name}' exceeds maximum ${binding.max}.`);
    return value;
  }
  if (typeof value !== 'boolean') throw new Error(`ComfyUI parameter '${name}' must be boolean.`);
  return value;
}

function resolvedParameters(preset: ComfyUiPreset, supplied: ComfyUiParameters): ComfyUiParameters {
  const known = new Set(Object.keys(preset.bindings));
  for (const name of Object.keys(supplied)) {
    if (!known.has(name)) throw new Error(`ComfyUI preset '${preset.id}' does not expose parameter '${name}'.`);
  }

  const out: ComfyUiParameters = {};
  for (const [name, binding] of Object.entries(preset.bindings)) {
    const suppliedValue = supplied[name];
    const fallback = 'default' in binding ? binding.default : undefined;
    const value = suppliedValue !== undefined ? suppliedValue : fallback;
    if (value === undefined) {
      if (binding.required) throw new Error(`ComfyUI preset '${preset.id}' requires parameter '${name}'.`);
      continue;
    }
    out[name] = validateParameter(binding, value, name);
  }
  return out;
}

function applyBindings(
  workflow: Record<string, unknown>,
  preset: ComfyUiPreset,
  params: ComfyUiParameters
): Record<string, unknown> {
  const cloned = structuredClone(workflow);
  for (const [name, value] of Object.entries(params)) {
    const binding = preset.bindings[name];
    if (!binding) throw new Error(`ComfyUI preset binding '${name}' disappeared during planning.`);
    const node = cloned[binding.nodeId];
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      throw new Error(`ComfyUI preset '${preset.id}' references missing node '${binding.nodeId}'.`);
    }
    const inputs = (node as Record<string, unknown>).inputs;
    if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) {
      throw new Error(`ComfyUI preset '${preset.id}' node '${binding.nodeId}' has no inputs object.`);
    }
    if (!Object.prototype.hasOwnProperty.call(inputs, binding.input)) {
      throw new Error(`ComfyUI preset '${preset.id}' references missing input '${binding.input}' on node '${binding.nodeId}'.`);
    }
    (inputs as Record<string, unknown>)[binding.input] = value;
  }
  return cloned;
}

function summarizeArtifacts(historyEntry: Record<string, unknown>) {
  const outputs = historyEntry.outputs;
  if (!outputs || typeof outputs !== 'object' || Array.isArray(outputs)) return [];
  const artifacts: Array<{ nodeId: string; kind: string; filename?: string; subfolder?: string; type?: string }> = [];
  for (const [nodeId, rawNode] of Object.entries(outputs).slice(0, 256)) {
    if (!rawNode || typeof rawNode !== 'object' || Array.isArray(rawNode)) continue;
    for (const kind of ['images', 'gifs', 'videos', 'audio']) {
      const items = (rawNode as Record<string, unknown>)[kind];
      if (!Array.isArray(items)) continue;
      for (const raw of items.slice(0, 64)) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
        const item = raw as Record<string, unknown>;
        artifacts.push({
          nodeId: nodeId.slice(0, 64),
          kind,
          ...(boundedString(item.filename, 260) ? { filename: boundedString(item.filename, 260) } : {}),
          ...(boundedString(item.subfolder, 260) ? { subfolder: boundedString(item.subfolder, 260) } : {}),
          ...(boundedString(item.type, 32) ? { type: boundedString(item.type, 32) } : {})
        });
        if (artifacts.length >= 256) return artifacts;
      }
    }
  }
  return artifacts;
}

export class ComfyUiPresetJobs {
  constructor(
    private readonly profiles: MediaProfileStore,
    private readonly presets: ComfyUiPresetStore
  ) {}

  async listPresets() {
    const items = await this.presets.list();
    return {
      presetCount: items.length,
      presets: items.map(item => this.presets.publicPreset(item))
    };
  }

  async plan(presetId: string, parameters: ComfyUiParameters) {
    const preset = await this.presets.get(presetId);
    const profile = await this.profiles.get(preset.profileId);
    const workflow = await this.presets.loadWorkflow(preset);
    const resolved = resolvedParameters(preset, parameters);
    applyBindings(workflow, preset, resolved);
    return {
      preset: this.presets.publicPreset(preset),
      provider: {
        profileId: profile.id,
        endpoint: endpoint(profile)
      },
      workflowNodeCount: Object.keys(workflow).length,
      resolvedParameters: resolved,
      authority: 'owner-local-preset-only',
      submitEndpoint: '/prompt'
    };
  }

  async submit(presetId: string, parameters: ComfyUiParameters, timeoutMs = 10_000) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 30_000) {
      throw new Error('ComfyUI submit timeoutMs must be 500..30000.');
    }
    const preset = await this.presets.get(presetId);
    const profile = await this.profiles.get(preset.profileId);
    const workflow = await this.presets.loadWorkflow(preset);
    const resolved = resolvedParameters(preset, parameters);
    const prompt = applyBindings(workflow, preset, resolved);
    const base = endpoint(profile);
    const response = await requestJson(`${base}/prompt`, {
      method: 'POST',
      timeoutMs,
      maxBytes: 512 * 1024,
      body: { prompt }
    });
    const obj = response && typeof response === 'object' && !Array.isArray(response)
      ? response as Record<string, unknown>
      : {};
    const promptId = boundedString(obj.prompt_id, 128);
    if (!promptId || !/^[A-Za-z0-9_-]{1,128}$/.test(promptId)) {
      throw new Error('ComfyUI /prompt response did not return a valid prompt_id.');
    }
    const number = Number.isInteger(obj.number) ? Number(obj.number) : undefined;
    return {
      presetId: preset.id,
      profileId: profile.id,
      promptId,
      ...(number !== undefined ? { queueNumber: number } : {}),
      resolvedParameters: resolved,
      accepted: true
    };
  }

  async status(profileId: string, promptId: string, timeoutMs = 5_000) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(promptId)) throw new Error('ComfyUI promptId is invalid.');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 15_000) {
      throw new Error('ComfyUI status timeoutMs must be 250..15000.');
    }
    const profile = await this.profiles.get(profileId);
    const base = endpoint(profile);
    const response = await requestJson(`${base}/history/${encodeURIComponent(promptId)}`, {
      timeoutMs,
      maxBytes: 4 * 1024 * 1024
    });
    const root = response && typeof response === 'object' && !Array.isArray(response)
      ? response as Record<string, unknown>
      : {};
    const rawEntry = root[promptId];
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
      return {
        profileId,
        promptId,
        found: false,
        completed: false,
        artifacts: []
      };
    }
    const entry = rawEntry as Record<string, unknown>;
    const status = entry.status && typeof entry.status === 'object' && !Array.isArray(entry.status)
      ? entry.status as Record<string, unknown>
      : {};
    return {
      profileId,
      promptId,
      found: true,
      completed: status.completed === true,
      status: boundedString(status.status_str, 64),
      artifacts: summarizeArtifacts(entry)
    };
  }
}
