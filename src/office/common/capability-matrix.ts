import {
  OFFICE_BACKENDS,
  type OfficeBackendDescriptor,
  type OfficeBackendId,
  type OfficeBackendRequirement
} from './contracts.js';

function cloneDescriptor(value: OfficeBackendDescriptor): OfficeBackendDescriptor {
  return { ...value, domains: [...value.domains], capabilities: [...value.capabilities] };
}

export class OfficeCapabilityMatrix {
  private readonly descriptors = new Map<OfficeBackendId, OfficeBackendDescriptor>();

  constructor(descriptors: OfficeBackendDescriptor[]) {
    for (const descriptor of descriptors) {
      if (!OFFICE_BACKENDS.includes(descriptor.id)) throw new Error(`Unknown Office backend '${descriptor.id}'.`);
      if (this.descriptors.has(descriptor.id)) throw new Error(`Duplicate Office backend '${descriptor.id}'.`);
      this.descriptors.set(descriptor.id, cloneDescriptor(descriptor));
    }
  }

  list(): OfficeBackendDescriptor[] {
    return [...this.descriptors.values()].map(cloneDescriptor);
  }

  get(id: OfficeBackendId): OfficeBackendDescriptor | undefined {
    const value = this.descriptors.get(id);
    return value ? cloneDescriptor(value) : undefined;
  }

  select(requirement: OfficeBackendRequirement): OfficeBackendDescriptor {
    if (requirement.capabilities.length === 0) throw new Error('Office backend selection requires at least one capability.');
    const allowed = requirement.allowedBackends ? new Set(requirement.allowedBackends) : undefined;
    const candidate = [...this.descriptors.values()].find(descriptor =>
      descriptor.status === 'available' &&
      descriptor.domains.includes(requirement.domain) &&
      (!allowed || allowed.has(descriptor.id)) &&
      requirement.capabilities.every(capability => descriptor.capabilities.includes(capability))
    );
    if (!candidate) {
      throw new Error(
        `OFFICE_BACKEND_UNAVAILABLE: no available backend satisfies ${requirement.domain} capabilities [${requirement.capabilities.join(', ')}].`
      );
    }
    return cloneDescriptor(candidate);
  }
}

export function currentOfficeCapabilityMatrix(platform = process.platform): OfficeCapabilityMatrix {
  return new OfficeCapabilityMatrix([
    {
      id: 'ooxml',
      status: 'available',
      domains: ['word'],
      capabilities: ['package.inspect', 'package.validate', 'word.inspect'],
      nativeApplication: false,
      headless: true,
      reason: 'Phase B provides bounded OOXML package preflight and structural Word inspection.'
    },
    {
      id: 'windows-com',
      status: platform === 'win32' ? 'not-implemented' : 'unavailable',
      domains: ['word', 'excel', 'powerpoint'],
      capabilities: [],
      nativeApplication: true,
      headless: false,
      reason: platform === 'win32'
        ? 'Native COM adapter is intentionally deferred until Word native acceptance.'
        : 'Microsoft Office COM automation is Windows-specific.'
    },
    {
      id: 'ui-automation',
      status: 'not-implemented',
      domains: ['word', 'excel', 'powerpoint'],
      capabilities: [],
      nativeApplication: true,
      headless: false,
      reason: 'UI automation is an explicit later fallback and is never selected implicitly.'
    }
  ]);
}
