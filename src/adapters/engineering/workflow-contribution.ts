export type EngineeringWorkflowStatus = 'succeeded' | 'failed' | 'blocked';

export interface EngineeringWorkflowStepResult {
  id: string;
  status: EngineeringWorkflowStatus;
  durationMs: number;
  result?: unknown;
  error?: string;
}

export interface EngineeringWorkflowContributionContext {
  workspace: string;
  projectPath: string;
  parameters: Readonly<Record<string, unknown>>;
}

export interface EngineeringWorkflowContributionExecution {
  status: EngineeringWorkflowStatus;
  steps: EngineeringWorkflowStepResult[];
  outputs?: Record<string, unknown>;
}

export interface EngineeringWorkflowContribution {
  readonly id: string;
  readonly description: string;
  readonly destructive: boolean;
  plan(context: EngineeringWorkflowContributionContext): Promise<Record<string, unknown>>;
  run(
    context: EngineeringWorkflowContributionContext & { plan: Record<string, unknown> }
  ): Promise<EngineeringWorkflowContributionExecution>;
}

const WORKFLOW_ID = /^[a-z0-9][a-z0-9._-]*$/;

function validateId(id: string): string {
  const normalized = id.trim();
  if (!normalized || normalized.length > 128 || !WORKFLOW_ID.test(normalized)) {
    throw new Error(`Invalid engineering workflow contribution id: ${id}`);
  }
  return normalized;
}

export class EngineeringWorkflowContributionRegistry {
  readonly #items = new Map<string, EngineeringWorkflowContribution>();

  constructor(private readonly reservedIds: ReadonlySet<string> = new Set()) {}

  add(contribution: EngineeringWorkflowContribution): this {
    const id = validateId(contribution.id);
    if (this.reservedIds.has(id)) {
      throw new Error(`Engineering workflow contribution '${id}' collides with a built-in workflow id.`);
    }
    if (this.#items.has(id)) {
      throw new Error(`Duplicate engineering workflow contribution id: ${id}`);
    }
    if (!contribution.description.trim() || contribution.description.length > 1024) {
      throw new Error(`Engineering workflow contribution '${id}' has an invalid description.`);
    }
    this.#items.set(id, contribution);
    return this;
  }

  get(id: string): EngineeringWorkflowContribution | undefined {
    return this.#items.get(id);
  }

  list(): readonly EngineeringWorkflowContribution[] {
    return [...this.#items.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
}
