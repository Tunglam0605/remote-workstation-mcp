import type { McpServer } from '@modelcontextprotocol/server';
import type { AppContext } from '../context.js';

export type ExtensionKind = 'domain' | 'productivity' | 'app';
export type RuntimePlatform = NodeJS.Platform;

export interface RwmcpExtension {
  readonly id: string;
  readonly version: number;
  readonly kind: ExtensionKind;
  readonly platforms?: readonly RuntimePlatform[];
  readonly register: (server: McpServer, ctx: AppContext) => void;
}

export interface ExtensionRegistrationResult {
  id: string;
  registered: boolean;
  reason?: 'unsupported-platform';
}
