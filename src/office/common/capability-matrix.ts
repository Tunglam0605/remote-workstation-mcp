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
      domains: ['word', 'excel', 'powerpoint'],
      capabilities: ['package.inspect', 'package.validate', 'word.inspect', 'word.edit', 'word.equation.omml', 'excel.inspect', 'excel.edit', 'powerpoint.inspect', 'powerpoint.edit'],
      nativeApplication: false,
      headless: true,
      reason: 'OOXML backend provides bounded package preflight plus structural Word/Excel/PowerPoint inspection and typed working-copy mutation; Word includes OMML equations, Excel bounded cell/range/formula edits, and PowerPoint bounded existing-shape/title text edits.'
    },
    {
      id: 'windows-com',
      status: platform === 'win32' ? 'available' : 'unavailable',
      domains: ['word', 'excel', 'powerpoint'],
      capabilities: platform === 'win32' ? ['word.inspect', 'word.equation.native-verify', 'word.render.pdf', 'excel.calculate', 'excel.render.pdf', 'powerpoint.inspect', 'powerpoint.render'] : [],
      nativeApplication: true,
      headless: false,
      reason: platform === 'win32'
        ? 'Native Office COM acceptance supports isolated Word open/OMath/PDF, Excel recalculation/formula-error/PDF, and PowerPoint read-only open/PDF with deterministic cleanup.'
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
