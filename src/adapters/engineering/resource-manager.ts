import { randomUUID } from 'node:crypto';
import type { EngineeringResourceLease, EngineeringResourceMode } from '../../engineering/types.js';

type OwnerIdSource = string | (() => string);

export class EngineeringResourceManager {
  private readonly leases = new Map<string, EngineeringResourceLease>();

  constructor(private readonly ownerIdSource: OwnerIdSource = 'unknown') {}

  private ownerId(): string {
    const value = typeof this.ownerIdSource === 'function' ? this.ownerIdSource() : this.ownerIdSource;
    return value || 'unknown';
  }

  acquire(resourceId: string, mode: EngineeringResourceMode): EngineeringResourceLease {
    const normalized = resourceId.trim();
    if (!normalized) throw new Error('Engineering resource id must not be empty.');
    const active = [...this.leases.values()].find(item => item.resourceId === normalized);
    if (active) {
      throw new Error(`RESOURCE_BUSY: '${normalized}' is already owned in ${active.mode} mode.`);
    }
    const lease: EngineeringResourceLease = {
      id: randomUUID(),
      resourceId: normalized,
      mode,
      ownerId: this.ownerId(),
      acquiredAt: new Date().toISOString()
    };
    this.leases.set(lease.id, lease);
    return { ...lease };
  }

  release(id: string): void {
    const active = this.leases.get(id);
    if (!active || active.ownerId !== this.ownerId()) throw new Error(`Unknown engineering lease '${id}'.`);
    this.leases.delete(id);
  }

  releaseInternal(id: string): void {
    this.leases.delete(id);
  }

  list(): EngineeringResourceLease[] {
    return [...this.leases.values()].map(item => ({ ...item, ownerId: item.ownerId === this.ownerId() ? item.ownerId : 'other-principal' }));
  }

  async withLease<T>(resourceId: string, mode: EngineeringResourceMode, operation: () => Promise<T>): Promise<T> {
    const lease = this.acquire(resourceId, mode);
    try {
      return await operation();
    } finally {
      this.releaseInternal(lease.id);
    }
  }
}
