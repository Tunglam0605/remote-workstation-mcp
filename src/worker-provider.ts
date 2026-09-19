export type WorkerProviderKind = 'codex' | 'claude' | 'openhands' | 'custom';
export type WorkerProviderAvailability = 'available' | 'unavailable' | 'disabled';

export interface WorkerProviderDescriptor {
  id: string;
  kind: WorkerProviderKind;
  displayName: string;
  worktreeAssignment: boolean;
  progressReporting: boolean;
  cancellationIntent: boolean;
}

export interface WorkerProviderStatus {
  provider: WorkerProviderDescriptor;
  availability: WorkerProviderAvailability;
  detail?: string;
  executionActive: false;
  authority: 'registry-only';
}

export interface WorkerProvider {
  descriptor: WorkerProviderDescriptor;
  status(): Promise<{ availability: WorkerProviderAvailability; detail?: string }>;
}

const PROVIDER_KINDS = new Set<WorkerProviderKind>(['codex', 'claude', 'openhands', 'custom']);
const PROVIDER_AVAILABILITY = new Set<WorkerProviderAvailability>(['available', 'unavailable', 'disabled']);

function safeDetail(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().replace(/\s+/g, ' ').slice(0, 512);
  if (!normalized) return undefined;
  const secretLike = [
    /authorization\s*:\s*bearer\s+\S+/i,
    /\bbearer\s+[A-Za-z0-9._~+\/-]{12,}/i,
    /\b(api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|passwd|secret)\s*[:=]\s*\S+/i,
    /\b(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,})\b/i,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i
  ];
  return secretLike.some(pattern => pattern.test(normalized))
    ? '[redacted provider detail]'
    : normalized;
}

export class WorkerProviderRegistry {
  private readonly providers = new Map<string, WorkerProvider>();

  constructor(
    private readonly maxProviders = 16,
    private readonly statusTimeoutMs = 2_000
  ) {
    if (!Number.isInteger(maxProviders) || maxProviders < 1 || maxProviders > 64) {
      throw new Error('maxProviders must be an integer between 1 and 64.');
    }
    if (!Number.isInteger(statusTimeoutMs) || statusTimeoutMs < 10 || statusTimeoutMs > 10_000) {
      throw new Error('statusTimeoutMs must be an integer between 10 and 10000 milliseconds.');
    }
  }

  register(provider: WorkerProvider): void {
    const descriptor = provider.descriptor;
    const id = descriptor.id.trim();
    const displayName = descriptor.displayName.trim();

    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) {
      throw new Error('Worker provider id must match [a-z0-9][a-z0-9._-]{0,63}.');
    }
    if (!PROVIDER_KINDS.has(descriptor.kind)) {
      throw new Error('Unsupported worker provider kind.');
    }
    if (!displayName || displayName.length > 128 || displayName.includes('\0')) {
      throw new Error('Worker provider displayName must contain 1..128 non-null characters.');
    }
    for (const [field, value] of [
      ['worktreeAssignment', descriptor.worktreeAssignment],
      ['progressReporting', descriptor.progressReporting],
      ['cancellationIntent', descriptor.cancellationIntent]
    ] as const) {
      if (typeof value !== 'boolean') throw new Error('Worker provider ' + field + ' must be boolean.');
    }
    if (this.providers.has(id)) throw new Error('Duplicate worker provider id ' + id + '.');
    if (this.providers.size >= this.maxProviders) throw new Error('Worker provider registry limit reached.');

    const normalizedDescriptor: WorkerProviderDescriptor = {
      id,
      kind: descriptor.kind,
      displayName,
      worktreeAssignment: descriptor.worktreeAssignment,
      progressReporting: descriptor.progressReporting,
      cancellationIntent: descriptor.cancellationIntent
    };

    this.providers.set(id, {
      descriptor: normalizedDescriptor,
      status: () => provider.status()
    });
  }

  descriptors(): WorkerProviderDescriptor[] {
    return [...this.providers.values()]
      .map(provider => structuredClone(provider.descriptor))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  private async probe(provider: WorkerProvider): Promise<{ availability: WorkerProviderAvailability; detail?: string }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        provider.status(),
        new Promise<{ availability: WorkerProviderAvailability; detail?: string }>(resolve => {
          timer = setTimeout(() => resolve({
            availability: 'unavailable',
            detail: 'status probe timed out'
          }), this.statusTimeoutMs);
        })
      ]);
      if (!PROVIDER_AVAILABILITY.has(result.availability)) {
        return { availability: 'unavailable', detail: 'provider returned invalid availability status' };
      }
      const detail = safeDetail(result.detail);
      return {
        availability: result.availability,
        ...(detail ? { detail } : {})
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async listStatus(): Promise<WorkerProviderStatus[]> {
    const providers = [...this.providers.values()].sort((a, b) => a.descriptor.id.localeCompare(b.descriptor.id));
    return Promise.all(providers.map(async provider => {
      try {
        const status = await this.probe(provider);
        return {
          provider: structuredClone(provider.descriptor),
          availability: status.availability,
          ...(status.detail ? { detail: status.detail } : {}),
          executionActive: false,
          authority: 'registry-only'
        };
      } catch (error) {
        return {
          provider: structuredClone(provider.descriptor),
          availability: 'unavailable',
          detail: safeDetail(error instanceof Error ? error.message : String(error)) ?? 'status probe failed',
          executionActive: false,
          authority: 'registry-only'
        };
      }
    }));
  }
}
