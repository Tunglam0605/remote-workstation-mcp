import type { McpServer } from '@modelcontextprotocol/server';
import type { AppContext } from '../context.js';
import type { ExtensionRegistrationResult, RwmcpExtension } from './types.js';

export class ExtensionRegistry {
  readonly #extensions = new Map<string, RwmcpExtension>();

  add(extension: RwmcpExtension): this {
    const id = extension.id.trim();
    if (!id) throw new Error('Extension id must not be empty.');
    if (this.#extensions.has(id)) throw new Error(`Duplicate extension id: ${id}`);
    if (!Number.isInteger(extension.version) || extension.version <= 0) {
      throw new Error(`Extension ${id} has an invalid version.`);
    }
    this.#extensions.set(id, extension);
    return this;
  }

  list(): readonly RwmcpExtension[] {
    return [...this.#extensions.values()];
  }

  registerAll(server: McpServer, ctx: AppContext, platform: NodeJS.Platform = process.platform): ExtensionRegistrationResult[] {
    return this.list().map(extension => {
      if (extension.platforms && !extension.platforms.includes(platform)) {
        return { id: extension.id, registered: false, reason: 'unsupported-platform' as const };
      }
      extension.register(server, ctx);
      return { id: extension.id, registered: true };
    });
  }
}
