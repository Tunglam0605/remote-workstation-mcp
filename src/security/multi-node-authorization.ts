import path from 'node:path';
import type { DeviceIdentity } from '../device-identity.js';
import type { MultiNodeTransferGrantConfig, MultiNodeTransferTransport } from '../model.js';
import { PolicyEngine } from '../policy.js';
import { AuditLogger } from './audit.js';
import { currentPrincipal, principalHasExactScope } from './request-principal.js';

export interface CrossNodeTransferIntent {
  grantId: string;
  sourceNodeId: string;
  destinationNodeId: string;
  sourceWorkspace: string;
  destinationWorkspace: string;
  sourcePath: string;
  destinationBasePath: string;
  destinationFileName: string;
  size: number;
  sha256?: string;
  transport: MultiNodeTransferTransport;
}

export interface CrossNodeAuthorizationResult {
  grantId: string;
  localRole: 'source' | 'destination';
  localNodeId: string;
  remoteNodeId: string;
  sourceWorkspace: string;
  destinationWorkspace: string;
  sourcePath: string;
  destinationBasePath: string;
  destinationFileName: string;
  size: number;
  transport: MultiNodeTransferTransport;
}

function normalizeRelative(value: string, label: string): string {
  const trimmed = value.trim().replaceAll('\\', '/');
  if (!trimmed) throw new Error(`${label} must not be empty.`);
  if (trimmed.startsWith('/') || /^[A-Za-z]:\//.test(trimmed)) {
    throw new Error(`${label} must be relative.`);
  }
  const parts = trimmed.split('/').filter(part => part && part !== '.');
  if (parts.includes('..')) throw new Error(`${label} must not contain traversal.`);
  return parts.length ? parts.join('/') : '.';
}

function withinPrefix(candidateRaw: string, prefixRaw: string): boolean {
  const candidate = normalizeRelative(candidateRaw, 'sourcePath');
  const prefix = normalizeRelative(prefixRaw, 'sourcePathPrefix');
  return prefix === '.' || candidate === prefix || candidate.startsWith(`${prefix}/`);
}

function exactBase(candidateRaw: string, allowedRaw: string): boolean {
  return normalizeRelative(candidateRaw, 'destinationBasePath') === normalizeRelative(allowedRaw, 'destinationBasePath');
}

function extensionOf(fileName: string): string {
  return path.posix.extname(fileName.replaceAll('\\', '/')).toLowerCase();
}

function normalizedSha(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const sha = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha)) throw new Error('sha256 must contain exactly 64 hexadecimal characters.');
  return sha;
}

function safeNodeId(value: string, label: string): string {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(trimmed)) throw new Error(`${label} is invalid.`);
  return trimmed;
}

function safeWorkspace(value: string, label: string): string {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(trimmed)) throw new Error(`${label} is invalid.`);
  return trimmed;
}

function validateSize(size: number): number {
  if (!Number.isSafeInteger(size) || size <= 0 || size > 512 * 1024 * 1024) {
    throw new Error('Cross-node transfer size must be an integer between 1 and 536870912 bytes.');
  }
  return size;
}

function validateDestinationFileName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 180 || path.posix.basename(trimmed) !== trimmed || !/^[A-Za-z0-9._-]+$/.test(trimmed)) {
    throw new Error('destinationFileName must be a plain filename.');
  }
  return trimmed;
}

export class MultiNodeAuthorization {
  constructor(
    private readonly policy: PolicyEngine,
    private readonly identity: DeviceIdentity,
    private readonly audit: AuditLogger
  ) {}

  status() {
    const config = this.policy.config.multiNode;
    return {
      enabled: config?.enabled ?? false,
      defaultDeny: true,
      secureTunnelOnly: true,
      localNodeId: this.identity.id,
      configuredGrantCount: config?.grants.filter(item => item.enabled !== false).length ?? 0,
      requiredScope: 'workstation.cross_node_transfer'
    };
  }

  private assertController(): void {
    const config = this.policy.config.multiNode;
    if (!(config?.enabled ?? false)) {
      throw new Error('Cross-node transfer is disabled by local owner policy (multiNode.enabled=false).');
    }
    const principal = currentPrincipal();
    if (!principal) {
      throw new Error('Cross-node transfer requires an authenticated OpenAI Secure MCP Tunnel principal; local/unauthenticated callers are denied.');
    }
    if (principal.id !== config!.controllerPrincipalId || principal.type !== config!.controllerPrincipalType) {
      throw new Error('Cross-node transfer requires the owner-approved OpenAI Secure MCP Tunnel principal.');
    }
    if (!principalHasExactScope('workstation.cross_node_transfer')) {
      throw new Error("Authenticated controller lacks the dedicated 'workstation.cross_node_transfer' scope.");
    }
  }

  private grantFor(intent: CrossNodeTransferIntent): MultiNodeTransferGrantConfig {
    const grants = this.policy.config.multiNode?.grants ?? [];
    const grant = grants.find(item => item.id === intent.grantId && item.enabled !== false);
    if (!grant) throw new Error(`Cross-node transfer grant '${intent.grantId}' is not enabled on this node.`);
    return grant;
  }

  private validateGrant(grant: MultiNodeTransferGrantConfig, intent: CrossNodeTransferIntent): void {
    if (grant.sourceNodeId !== intent.sourceNodeId || grant.destinationNodeId !== intent.destinationNodeId) {
      throw new Error('Cross-node transfer node identities do not match the owner grant.');
    }
    if (grant.sourceWorkspace !== intent.sourceWorkspace || grant.destinationWorkspace !== intent.destinationWorkspace) {
      throw new Error('Cross-node transfer workspaces do not match the owner grant.');
    }
    if (!grant.transports.includes(intent.transport)) {
      throw new Error(`Transfer transport '${intent.transport}' is not allowed by grant '${grant.id}'.`);
    }
    if (intent.size > grant.maxBytes) {
      throw new Error(`Transfer size ${intent.size} exceeds grant '${grant.id}' limit ${grant.maxBytes}.`);
    }
    if (!grant.sourcePathPrefixes.some(prefix => withinPrefix(intent.sourcePath, prefix))) {
      throw new Error(`Source path is outside the prefixes allowed by grant '${grant.id}'.`);
    }
    if (!grant.destinationBasePaths.some(base => exactBase(intent.destinationBasePath, base))) {
      throw new Error(`Destination base path is not allowed by grant '${grant.id}'.`);
    }

    const sourceExt = extensionOf(intent.sourcePath);
    const destinationExt = extensionOf(intent.destinationFileName);
    const allowed = new Set(grant.allowedExtensions.map(item => item.toLowerCase()));
    if (!sourceExt || !allowed.has(sourceExt)) {
      throw new Error(`Source file extension '${sourceExt || '<none>'}' is not allowed by grant '${grant.id}'.`);
    }
    if (!destinationExt || !allowed.has(destinationExt)) {
      throw new Error(`Destination file extension '${destinationExt || '<none>'}' is not allowed by grant '${grant.id}'.`);
    }
  }

  private normalizedIntent(intent: CrossNodeTransferIntent): CrossNodeTransferIntent {
    return {
      grantId: intent.grantId.trim(),
      sourceNodeId: safeNodeId(intent.sourceNodeId, 'sourceNodeId'),
      destinationNodeId: safeNodeId(intent.destinationNodeId, 'destinationNodeId'),
      sourceWorkspace: safeWorkspace(intent.sourceWorkspace, 'sourceWorkspace'),
      destinationWorkspace: safeWorkspace(intent.destinationWorkspace, 'destinationWorkspace'),
      sourcePath: normalizeRelative(intent.sourcePath, 'sourcePath'),
      destinationBasePath: normalizeRelative(intent.destinationBasePath, 'destinationBasePath'),
      destinationFileName: validateDestinationFileName(intent.destinationFileName),
      size: validateSize(intent.size),
      sha256: normalizedSha(intent.sha256),
      transport: intent.transport
    };
  }

  private async authorize(role: 'source' | 'destination', rawIntent: CrossNodeTransferIntent): Promise<CrossNodeAuthorizationResult> {
    const started = Date.now();
    let intent: CrossNodeTransferIntent | undefined;
    try {
      this.assertController();
      intent = this.normalizedIntent(rawIntent);
      if (!/^[A-Za-z0-9._-]{1,96}$/.test(intent.grantId)) throw new Error('grantId is invalid.');

      if (role === 'source') {
        if (intent.sourceNodeId !== this.identity.id) {
          throw new Error('Source node identity does not match this Direct Node.');
        }
        this.policy.workspace(intent.sourceWorkspace);
      } else {
        if (intent.destinationNodeId !== this.identity.id) {
          throw new Error('Destination node identity does not match this Direct Node.');
        }
        this.policy.workspace(intent.destinationWorkspace);
        this.policy.assertWrite(intent.destinationWorkspace);
      }

      const grant = this.grantFor(intent);
      this.validateGrant(grant, intent);
      const result: CrossNodeAuthorizationResult = {
        grantId: grant.id,
        localRole: role,
        localNodeId: this.identity.id,
        remoteNodeId: role === 'source' ? intent.destinationNodeId : intent.sourceNodeId,
        sourceWorkspace: intent.sourceWorkspace,
        destinationWorkspace: intent.destinationWorkspace,
        sourcePath: intent.sourcePath,
        destinationBasePath: intent.destinationBasePath,
        destinationFileName: intent.destinationFileName,
        size: intent.size,
        transport: intent.transport
      };
      await this.audit.recordSecurityEvent('multi_node.transfer_authorization', true, {
        ...result,
        sha256: intent.sha256,
        durationMs: Date.now() - started
      });
      return result;
    } catch (error) {
      await this.audit.recordSecurityEvent('multi_node.transfer_authorization', false, {
        localRole: role,
        localNodeId: this.identity.id,
        grantId: rawIntent.grantId,
        sourceNodeId: rawIntent.sourceNodeId,
        destinationNodeId: rawIntent.destinationNodeId,
        sourceWorkspace: rawIntent.sourceWorkspace,
        destinationWorkspace: rawIntent.destinationWorkspace,
        sourcePath: rawIntent.sourcePath,
        destinationBasePath: rawIntent.destinationBasePath,
        destinationFileName: rawIntent.destinationFileName,
        size: rawIntent.size,
        transport: rawIntent.transport,
        sha256: rawIntent.sha256,
        durationMs: Date.now() - started
      }, error);
      throw error;
    }
  }

  async authorizeSource(intent: CrossNodeTransferIntent): Promise<CrossNodeAuthorizationResult> {
    return await this.authorize('source', intent);
  }

  async authorizeDestination(intent: CrossNodeTransferIntent): Promise<CrossNodeAuthorizationResult> {
    return await this.authorize('destination', intent);
  }
}
