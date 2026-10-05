export const OPENAI_TOOL_PACK_IDS = ['camera', 'canopen', 'media', 'industrial'] as const;

export type OpenAiToolPackId = typeof OPENAI_TOOL_PACK_IDS[number];
export type OpenAiToolSurface = 'baseline' | 'full';

export interface OpenAiToolExposureStatus {
  mode: 'baseline' | 'baseline-plus-packs' | 'full';
  packs: OpenAiToolPackId[];
}

export const OPENAI_TOOL_PACK_CAPABILITY_IDS: Record<OpenAiToolPackId, readonly string[]> = {
  camera: ['engineering.camera'],
  canopen: ['engineering.canopen'],
  media: ['engineering.media'],
  industrial: [
    'engineering.mqtt',
    'engineering.industrial_profiles',
    'engineering.opcua',
    'engineering.modbus_tcp'
  ]
};

export type CapabilityExposureReason = 'baseline' | 'selected-pack' | 'full' | 'pack-not-selected';

export interface CapabilityToolExposure {
  exposed: boolean;
  toolPack: OpenAiToolPackId | null;
  reason: CapabilityExposureReason;
  enablePack?: OpenAiToolPackId;
}

export type OpenAiToolPackExposureReason = 'selected-pack' | 'full' | 'not-selected';

export interface OpenAiToolPackCatalogEntry {
  id: OpenAiToolPackId;
  selected: boolean;
  exposed: boolean;
  reason: OpenAiToolPackExposureReason;
  capabilityIds: string[];
  toolCount: number;
}

export function isOpenAiToolClient(clientType: string): boolean {
  return clientType === 'openai-secure-mcp-tunnel' || clientType === 'chatgpt';
}

export function parseOpenAiToolPacks(raw: string | undefined): OpenAiToolPackId[] {
  if (!raw?.trim()) return [];
  const requested = new Set(
    raw
      .split(',')
      .map(value => value.trim())
      .filter(Boolean)
  );
  return OPENAI_TOOL_PACK_IDS.filter(id => requested.has(id));
}

export function resolveOpenAiToolSurface(
  clientType: string,
  env: NodeJS.ProcessEnv = process.env
): OpenAiToolSurface {
  if (isOpenAiToolClient(clientType) && env.RWMCP_OPENAI_TOOL_SURFACE !== 'full') {
    return 'baseline';
  }
  return 'full';
}

export function resolveOpenAiToolPacks(
  clientType: string,
  env: NodeJS.ProcessEnv = process.env
): OpenAiToolPackId[] {
  if (!isOpenAiToolClient(clientType)) return [];
  return parseOpenAiToolPacks(env.RWMCP_OPENAI_TOOL_PACKS);
}

export function describeOpenAiToolExposure(
  clientType: string,
  env: NodeJS.ProcessEnv = process.env
): OpenAiToolExposureStatus {
  const surface = resolveOpenAiToolSurface(clientType, env);
  if (surface === 'full') return { mode: 'full', packs: [] };
  const packs = resolveOpenAiToolPacks(clientType, env);
  return {
    mode: packs.length ? 'baseline-plus-packs' : 'baseline',
    packs
  };
}

export function toolPackForCapability(capabilityId: string): OpenAiToolPackId | undefined {
  return OPENAI_TOOL_PACK_IDS.find(pack => OPENAI_TOOL_PACK_CAPABILITY_IDS[pack].includes(capabilityId));
}

export function describeCapabilityToolExposure(
  capabilityId: string,
  clientType: string,
  env: NodeJS.ProcessEnv = process.env
): CapabilityToolExposure {
  const toolPack = toolPackForCapability(capabilityId);
  const surface = resolveOpenAiToolSurface(clientType, env);
  if (!toolPack) return { exposed: true, toolPack: null, reason: 'baseline' };
  if (surface === 'full') return { exposed: true, toolPack, reason: 'full' };
  const selected = resolveOpenAiToolPacks(clientType, env).includes(toolPack);
  return selected
    ? { exposed: true, toolPack, reason: 'selected-pack' }
    : { exposed: false, toolPack, reason: 'pack-not-selected', enablePack: toolPack };
}

export function describeOpenAiToolPackCatalog(
  capabilities: readonly { id: string; tools: readonly string[] }[],
  clientType: string,
  env: NodeJS.ProcessEnv = process.env
): OpenAiToolPackCatalogEntry[] {
  const surface = resolveOpenAiToolSurface(clientType, env);
  const selectedPacks = new Set(resolveOpenAiToolPacks(clientType, env));
  const byId = new Map(capabilities.map(capability => [capability.id, capability]));
  return OPENAI_TOOL_PACK_IDS.map(id => {
    const capabilityIds = [...OPENAI_TOOL_PACK_CAPABILITY_IDS[id]];
    const toolCount = capabilityIds.reduce((sum, capabilityId) => sum + (byId.get(capabilityId)?.tools.length ?? 0), 0);
    const selected = selectedPacks.has(id);
    const exposed = surface === 'full' || selected;
    const reason: OpenAiToolPackExposureReason = surface === 'full'
      ? 'full'
      : selected
        ? 'selected-pack'
        : 'not-selected';
    return { id, selected, exposed, reason, capabilityIds, toolCount };
  });
}
