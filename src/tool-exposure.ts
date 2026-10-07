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

export interface OpenAiToolPackMetadata {
  label: string;
  summary: string;
  recommendedFor: readonly string[];
  notNeededFor: readonly string[];
}

export const OPENAI_TOOL_PACK_METADATA: Record<OpenAiToolPackId, OpenAiToolPackMetadata> = {
  camera: {
    label: 'Camera',
    summary: 'RTSP/ONVIF camera diagnostics, stream metadata, bounded PTZ and multi-camera health observation.',
    recommendedFor: [
      'RTSP or ONVIF camera discovery and health checks',
      'camera stream metadata and bounded fleet diagnostics',
      'bounded ONVIF PTZ inspection or movement'
    ],
    notNeededFor: [
      'generic network diagnostics that do not require camera protocols'
    ]
  },
  canopen: {
    label: 'CANopen',
    summary: 'Reusable CANopen EDS/DCF semantics and passive SDO/PDO/NMT/Heartbeat/EMCY analysis.',
    recommendedFor: [
      'CANopen EDS or DCF inspection and Object Dictionary work',
      'passive CANopen node, SDO, PDO, NMT, Heartbeat or EMCY analysis',
      'semantic decoding of CAN captures using configured CANopen communication objects'
    ],
    notNeededFor: [
      'raw CAN interface status or capture that does not require CANopen semantics'
    ]
  },
  media: {
    label: 'Media / video',
    summary: 'Bounded media probing/transcoding plus typed Remotion, ComfyUI and guarded CapCut draft-editing workflows.',
    recommendedFor: [
      'media file inspection or bounded transcoding',
      'typed Remotion preset rendering',
      'typed ComfyUI jobs and artifact handoff',
      'guarded CapCut timeline inspection and typed draft editing'
    ],
    notNeededFor: [
      'ordinary filesystem work that does not require media processing or rendering'
    ]
  },
  industrial: {
    label: 'Industrial protocols',
    summary: 'Generic MQTT observation, industrial endpoint profiles, OPC UA and Modbus TCP diagnostics.',
    recommendedFor: [
      'generic MQTT subscribe-only observation',
      'industrial endpoint profile inspection or preflight',
      'read-only OPC UA browse/read diagnostics',
      'read-only Modbus TCP diagnostics'
    ],
    notNeededFor: [
      'Modbus RTU-only work, which remains available in the baseline surface',
      'generic network reachability checks that do not require an industrial protocol'
    ]
  }
};

export const OPENAI_TOOL_PACK_SELECTION_POLICY = {
  mode: 'recommend-only',
  automaticActivation: false,
  ownerControlled: true,
  restartRequired: true,
  baselineAlwaysAvailable: true,
  fullSurfaceExplicitOptIn: true
} as const;

export type CapabilityExposureReason = 'baseline' | 'selected-pack' | 'full' | 'pack-not-selected';

export interface CapabilityToolExposure {
  exposed: boolean;
  toolPack: OpenAiToolPackId | null;
  reason: CapabilityExposureReason;
  enablePack?: OpenAiToolPackId;
}

export type OpenAiToolPackExposureReason = 'selected-pack' | 'full' | 'not-selected';

export interface OpenAiToolPackCatalogEntry extends OpenAiToolPackMetadata {
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
    const metadata = OPENAI_TOOL_PACK_METADATA[id];
    return { id, ...metadata, selected, exposed, reason, capabilityIds, toolCount };
  });
}
