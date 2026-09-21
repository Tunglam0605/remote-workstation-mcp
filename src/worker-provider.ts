export type WorkerProviderKind = 'codex' | 'antigravity' | 'claude' | 'openhands' | 'custom';
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
  dispatchCapable: boolean;
  executionActive: boolean;
  activeDispatches: number;
  authority: 'registry-only';
}

export interface WorkerDispatchRequest {
  version: 1;
  workSessionId: string;
  objective: {
    id: string;
    name: string;
    objective: string;
  };
  task: {
    id: string;
    generation: number;
    title: string;
    description?: string;
  };
  project?: {
    workspace: string;
    projectPath: string;
    worktreePath?: string;
    buildDir?: string;
    branch?: string;
    commit?: string;
  };
}

export interface WorkerDispatchResult {
  status: 'succeeded' | 'failed' | 'blocked';
  runId?: string;
  summary?: string;
}

export interface WorkerProvider {
  descriptor: WorkerProviderDescriptor;
  status(): Promise<{ availability: WorkerProviderAvailability; detail?: string }>;
  dispatch?(request: WorkerDispatchRequest): Promise<WorkerDispatchResult>;
}

const PROVIDER_KINDS = new Set<WorkerProviderKind>(['codex', 'antigravity', 'claude', 'openhands', 'custom']);
const PROVIDER_AVAILABILITY = new Set<WorkerProviderAvailability>(['available', 'unavailable', 'disabled']);

function boundedText(value: string, field: string, max: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max || normalized.includes('\0')) {
    throw new Error(field + ' must be non-empty text of at most ' + max + ' characters.');
  }
  return normalized;
}

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

function normalizeDispatchRequest(request: WorkerDispatchRequest): WorkerDispatchRequest {
  if (!request || request.version !== 1) throw new Error('Worker dispatch request version must be 1.');
  if (!Number.isSafeInteger(request.task?.generation) || request.task.generation < 1 || request.task.generation > 1_000_000) {
    throw new Error('Worker dispatch task generation is invalid.');
  }
  const normalized: WorkerDispatchRequest = {
    version: 1,
    workSessionId: boundedText(request.workSessionId, 'workSessionId', 64),
    objective: {
      id: boundedText(request.objective.id, 'objective.id', 64),
      name: boundedText(request.objective.name, 'objective.name', 128),
      objective: boundedText(request.objective.objective, 'objective.objective', 2048)
    },
    task: {
      id: boundedText(request.task.id, 'task.id', 64),
      generation: request.task.generation,
      title: boundedText(request.task.title, 'task.title', 256),
      ...(request.task.description?.trim()
        ? { description: boundedText(request.task.description, 'task.description', 2048) }
        : {})
    }
  };
  if (request.project) {
    normalized.project = {
      workspace: boundedText(request.project.workspace, 'project.workspace', 128),
      projectPath: boundedText(request.project.projectPath, 'project.projectPath', 1024),
      ...(request.project.worktreePath?.trim()
        ? { worktreePath: boundedText(request.project.worktreePath, 'project.worktreePath', 1024) }
        : {}),
      ...(request.project.buildDir?.trim()
        ? { buildDir: boundedText(request.project.buildDir, 'project.buildDir', 1024) }
        : {}),
      ...(request.project.branch?.trim()
        ? { branch: boundedText(request.project.branch, 'project.branch', 256) }
        : {}),
      ...(request.project.commit?.trim()
        ? { commit: boundedText(request.project.commit, 'project.commit', 128) }
        : {})
    };
  }
  return normalized;
}

function normalizeDispatchResult(result: WorkerDispatchResult): WorkerDispatchResult {
  if (!result || !['succeeded', 'failed', 'blocked'].includes(result.status)) {
    throw new Error('Worker provider returned an invalid dispatch status.');
  }
  const runId = result.runId?.trim();
  const summary = safeDetail(result.summary);
  return {
    status: result.status,
    ...(runId ? { runId: boundedText(runId, 'worker run id', 128) } : {}),
    ...(summary ? { summary } : {})
  };
}

export class WorkerProviderRegistry {
  private readonly providers = new Map<string, WorkerProvider>();
  private readonly activeDispatchCounts = new Map<string, number>();

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
      status: () => provider.status(),
      ...(provider.dispatch ? { dispatch: (request: WorkerDispatchRequest) => provider.dispatch!(request) } : {})
    });
  }

  descriptors(): WorkerProviderDescriptor[] {
    return [...this.providers.values()]
      .map(provider => structuredClone(provider.descriptor))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  descriptor(providerId: string): WorkerProviderDescriptor | undefined {
    const id = providerId.trim();
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) return undefined;
    const provider = this.providers.get(id);
    return provider ? structuredClone(provider.descriptor) : undefined;
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
      const activeDispatches = this.activeDispatchCounts.get(provider.descriptor.id) ?? 0;
      try {
        const status = await this.probe(provider);
        return {
          provider: structuredClone(provider.descriptor),
          availability: status.availability,
          ...(status.detail ? { detail: status.detail } : {}),
          dispatchCapable: typeof provider.dispatch === 'function',
          executionActive: activeDispatches > 0,
          activeDispatches,
          authority: 'registry-only'
        };
      } catch (error) {
        return {
          provider: structuredClone(provider.descriptor),
          availability: 'unavailable',
          detail: safeDetail(error instanceof Error ? error.message : String(error)) ?? 'status probe failed',
          dispatchCapable: typeof provider.dispatch === 'function',
          executionActive: activeDispatches > 0,
          activeDispatches,
          authority: 'registry-only'
        };
      }
    }));
  }

  async dispatch(providerId: string, request: WorkerDispatchRequest): Promise<WorkerDispatchResult> {
    const id = providerId.trim();
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) {
      throw new Error('Worker provider id must match [a-z0-9][a-z0-9._-]{0,63}.');
    }
    const provider = this.providers.get(id);
    if (!provider) throw new Error('Unknown worker provider ' + id + '.');
    if (!provider.dispatch) throw new Error('Worker provider ' + id + ' is not dispatch-capable.');
    const status = await this.probe(provider);
    if (status.availability !== 'available') {
      throw new Error('Worker provider ' + id + ' is not available' + (status.detail ? ': ' + status.detail : '.'));
    }
    const normalized = normalizeDispatchRequest(request);
    if (provider.descriptor.worktreeAssignment && !normalized.project?.worktreePath) {
      throw new Error('Worker provider ' + id + ' requires an isolated Work Session worktree before dispatch.');
    }
    const active = (this.activeDispatchCounts.get(id) ?? 0) + 1;
    this.activeDispatchCounts.set(id, active);
    try {
      return normalizeDispatchResult(await provider.dispatch(normalized));
    } finally {
      const remaining = Math.max(0, (this.activeDispatchCounts.get(id) ?? 1) - 1);
      if (remaining === 0) this.activeDispatchCounts.delete(id);
      else this.activeDispatchCounts.set(id, remaining);
    }
  }
}
