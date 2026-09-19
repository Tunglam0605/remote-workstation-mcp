import { randomUUID } from 'node:crypto';
import type { EngineeringResourceLease, EngineeringResourceMode } from '../../engineering/types.js';
import {
  resolveResourceOwner,
  type ResourceOwnerSource
} from '../../security/execution-context.js';

type ManagedLease = EngineeringResourceLease & {
  ownerKey: string;
  ownerPrincipalId: string;
  workSessionId: string;
};

export class EngineeringResourceManager {
  private readonly leases = new Map<string, ManagedLease>();

  constructor(private readonly ownerSource: ResourceOwnerSource = 'unknown') {}

  acquire(resourceId: string, mode: EngineeringResourceMode): EngineeringResourceLease {
    const normalized = resourceId.trim();
    if (!normalized) throw new Error('Engineering resource id must not be empty.');
    const active = [...this.leases.values()].find(item => item.resourceId === normalized);
    if (active) {
      throw new Error(`RESOURCE_BUSY: '${normalized}' is already owned in ${active.mode} mode.`);
    }

    const owner = resolveResourceOwner(this.ownerSource);
    const lease: ManagedLease = {
      id: randomUUID(),
      resourceId: normalized,
      mode,
      ownerId: owner.principalId,
      ownerKey: owner.key,
      ownerPrincipalId: owner.principalId,
      workSessionId: owner.workSessionId,
      acquiredAt: new Date().toISOString()
    };
    this.leases.set(lease.id, lease);
    return this.snapshot(lease, owner.key, owner.principalId);
  }

  release(id: string): void {
    const active = this.leases.get(id);
    const owner = resolveResourceOwner(this.ownerSource);
    if (!active || active.ownerKey !== owner.key) throw new Error(`Unknown engineering lease '${id}'.`);
    this.leases.delete(id);
  }

  releaseInternal(id: string): void {
    this.leases.delete(id);
  }

  list(): EngineeringResourceLease[] {
    const owner = resolveResourceOwner(this.ownerSource);
    return [...this.leases.values()].map(item => this.snapshot(item, owner.key, owner.principalId));
  }

  activeCount(): number {
    return this.leases.size;
  }

  async withLease<T>(resourceId: string, mode: EngineeringResourceMode, operation: () => Promise<T>): Promise<T> {
    const lease = this.acquire(resourceId, mode);
    try {
      return await operation();
    } finally {
      this.releaseInternal(lease.id);
    }
  }

  private snapshot(item: ManagedLease, ownerKey: string, principalId: string): EngineeringResourceLease {
    const {
      ownerKey: itemOwnerKey,
      ownerPrincipalId,
      workSessionId: _workSessionId,
      ...lease
    } = item;
    return {
      ...lease,
      ownerId: itemOwnerKey === ownerKey
        ? principalId
        : ownerPrincipalId === principalId
          ? 'other-session'
          : 'other-principal'
    };
  }
}
