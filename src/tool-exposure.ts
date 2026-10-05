export const OPENAI_TOOL_PACK_IDS = ['camera', 'canopen', 'media', 'industrial'] as const;

export type OpenAiToolPackId = typeof OPENAI_TOOL_PACK_IDS[number];
export type OpenAiToolSurface = 'baseline' | 'full';

export interface OpenAiToolExposureStatus {
  mode: 'baseline' | 'baseline-plus-packs' | 'full';
  packs: OpenAiToolPackId[];
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
