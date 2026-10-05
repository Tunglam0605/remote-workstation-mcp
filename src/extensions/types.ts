import type { McpServer } from '@modelcontextprotocol/server';
import type { AppContext } from '../context.js';
import type { OpenAiToolPackId } from '../tool-exposure.js';

export type ExtensionKind = 'domain' | 'productivity' | 'app';
export type ExtensionExposure = 'baseline' | 'expanded';
export type RuntimePlatform = NodeJS.Platform;

export interface RwmcpExtension {
  readonly id: string;
  readonly version: number;
  readonly kind: ExtensionKind;
  readonly platforms?: readonly RuntimePlatform[];
  readonly exposure?: ExtensionExposure;
  readonly toolPack?: OpenAiToolPackId;
  readonly initialize?: (ctx: AppContext) => void;
  readonly register: (server: McpServer, ctx: AppContext) => void;
}

export interface ExtensionRegistrationResult {
  id: string;
  registered: boolean;
  reason?: 'unsupported-platform' | 'client-surface-filtered';
}
