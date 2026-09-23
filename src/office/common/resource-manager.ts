import { randomUUID } from 'node:crypto';
import { resolveResourceOwner, type ResourceOwnerSource } from '../../security/execution-context.js';

interface OfficeLease {
  id: string;
  resourceKey: string;
  mode: 'read' | 'write';
  ownerKey: string;
  principalId: string;
  workSessionId: string;
  acquiredAt: string;
}

export interface OfficeLeaseView {
  id: string;
  resourceKey: string;
  mode: 'read' | 'write';
  ownerId: string;
  workSessionId: string;
  acquiredAt: string;
}

export class OfficeResourceManager {
  private readonly leases = new Map<string, OfficeLease>();

  constructor(private readonly ownerSource: ResourceOwnerSource = 'unknown') {}

  acquire(resourceKey: string, mode: 'read' | 'write'): OfficeLeaseView {
    const normalized = resourceKey.trim();
    if (!normalized) throw new Error('Office resource key must not be empty.');
    const owner = resolveResourceOwner(this.ownerSource);
    const conflicts = [...this.leases.values()].filter(item =>
      item.resourceKey === normalized &&
      (mode === 'write' || item.mode === 'write')
    );
    if (conflicts.length > 0) {
      throw new Error(`OFFICE_RESOURCE_BUSY: '${normalized}' has an active conflicting lease.`);
    }
    const lease: OfficeLease = {
      id: randomUUID(),
      resourceKey: normalized,
      mode,
      ownerKey: owner.key,
      principalId: owner.principalId,
      workSessionId: owner.workSessionId,
      acquiredAt: new Date().toISOString()
    };
    this.leases.set(lease.id, lease);
    return this.view(lease, owner.key, owner.principalId);
  }

  release(id: string): void {
    const owner = resolveResourceOwner(this.ownerSource);
    const lease = this.leases.get(id);
    if (!lease || lease.ownerKey !== owner.key) throw new Error(`Unknown Office lease '${id}'.`);
    this.leases.delete(id);
  }

  listOwned(): OfficeLeaseView[] {
    const owner = resolveResourceOwner(this.ownerSource);
    return [...this.leases.values()]
      .filter(item => item.ownerKey === owner.key)
      .map(item => this.view(item, owner.key, owner.principalId));
  }

  activeCount(): number {
    return this.leases.size;
  }

  async withLease<T>(resourceKey: string, mode: 'read' | 'write', operation: () => Promise<T>): Promise<T> {
    const lease = this.acquire(resourceKey, mode);
    try {
      return await operation();
    } finally {
      this.leases.delete(lease.id);
    }
  }

  private view(lease: OfficeLease, ownerKey: string, principalId: string): OfficeLeaseView {
    return {
      id: lease.id,
      resourceKey: lease.resourceKey,
      mode: lease.mode,
      ownerId: lease.ownerKey === ownerKey
        ? principalId
        : lease.principalId === principalId ? 'other-session' : 'other-principal',
      workSessionId: lease.workSessionId,
      acquiredAt: lease.acquiredAt
    };
  }
}
