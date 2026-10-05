import type { McpServer } from '@modelcontextprotocol/server';
import type { AppContext } from '../context.js';
import {
  resolveOpenAiToolPacks,
  resolveOpenAiToolSurface,
  type OpenAiToolPackId,
  type OpenAiToolSurface
} from '../tool-exposure.js';
import type { ExtensionRegistrationResult, RwmcpExtension } from './types.js';

export type ExtensionToolSurface = OpenAiToolSurface;
export const resolveExtensionToolSurface = resolveOpenAiToolSurface;

const initializedExtensionIdsByContext = new WeakMap<AppContext, Set<string>>();

function initializeExtensionOnce(extension: RwmcpExtension, ctx: AppContext): void {
  if (!extension.initialize) return;
  let initialized = initializedExtensionIdsByContext.get(ctx);
  if (!initialized) {
    initialized = new Set<string>();
    initializedExtensionIdsByContext.set(ctx, initialized);
  }
  const id = extension.id.trim();
  if (initialized.has(id)) return;
  extension.initialize(ctx);
  initialized.add(id);
}

export class ExtensionRegistry {
  readonly #extensions = new Map<string, RwmcpExtension>();

  add(extension: RwmcpExtension): this {
    const id = extension.id.trim();
    if (!id) throw new Error('Extension id must not be empty.');
    if (this.#extensions.has(id)) throw new Error(`Duplicate extension id: ${id}`);
    if (!Number.isInteger(extension.version) || extension.version <= 0) {
      throw new Error(`Extension ${id} has an invalid version.`);
    }
    if (extension.exposure === 'expanded' && !extension.toolPack) {
      throw new Error(`Expanded extension ${id} must declare a tool pack.`);
    }
    if (extension.toolPack && extension.exposure !== 'expanded') {
      throw new Error(`Baseline extension ${id} must not declare a tool pack.`);
    }
    this.#extensions.set(id, extension);
    return this;
  }

  list(): readonly RwmcpExtension[] {
    return [...this.#extensions.values()];
  }

  registerAll(
    server: McpServer,
    ctx: AppContext,
    platform: NodeJS.Platform = process.platform,
    toolSurface: ExtensionToolSurface = resolveExtensionToolSurface(ctx.actor.clientType),
    toolPacks: readonly OpenAiToolPackId[] = resolveOpenAiToolPacks(ctx.actor.clientType)
  ): ExtensionRegistrationResult[] {
    return this.list().map(extension => {
      if (extension.platforms && !extension.platforms.includes(platform)) {
        return { id: extension.id, registered: false, reason: 'unsupported-platform' as const };
      }
      if (
        toolSurface === 'baseline' &&
        extension.exposure === 'expanded' &&
        (!extension.toolPack || !toolPacks.includes(extension.toolPack))
      ) {
        return { id: extension.id, registered: false, reason: 'client-surface-filtered' as const };
      }
      initializeExtensionOnce(extension, ctx);
      extension.register(server, ctx);
      return { id: extension.id, registered: true };
    });
  }
}
