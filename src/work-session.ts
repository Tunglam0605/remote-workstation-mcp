import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setupConfigDir } from './setup/settings.js';

export const IMPLICIT_WORK_SESSION_ID = 'implicit' as const;

export type WorkSessionStatus = 'active' | 'closed';

export type ConcurrencyClass =
  | 'shared'
  | 'session-isolated'
  | 'resource-exclusive'
  | 'project-variant-exclusive'
  | 'node-exclusive'
  | 'owner-local-only';

export interface ResourceOwner {
  principalId: string;
  workSessionId: string;
  implicit: boolean;
  key: string;
}

export interface ContextCapsuleProject {
  workspace: string;
  projectPath?: string;
  repoPath?: string;
  worktreePath?: string;
  branch?: string;
  commit?: string;
  buildDir?: string;
}

export interface ContextCapsule {
  version: 1;
  project?: ContextCapsuleProject;
  currentObjective?: string;
  validatedFacts: string[];
  selectedProvider?: string;
  selectedToolchain?: string;
  selectedVariant?: string;
  lastSuccessfulBuild?: string;
  lastSuccessfulDeploy?: string;
  lastAcceptance?: string;
  blockers: string[];
  decisions: string[];
  pendingActions: string[];
}

export interface WorkSession {
  version: 1;
  id: string;
  principalId: string;
  status: WorkSessionStatus;
  name?: string;
  createdAt: string;
  updatedAt: string;
  capsule: ContextCapsule;
}

type PrincipalIdSource = string | (() => string);

interface WorkSessionFileV1 {
  version: 1;
  sessions: WorkSession[];
}

export interface WorkSessionCreateInput {
  name?: string;
  workspace?: string;
  projectPath?: string;
  objective?: string;
}

export interface WorkSessionStoreOptions {
  file?: string;
  now?: () => Date;
}

function boundedText(value: string | undefined, field: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (normalized.length > max || normalized.includes('\0')) {
    throw new Error(`${field} must be non-empty text of at most ${max} characters.`);
  }
  return normalized;
}

function validateSession(value: unknown): WorkSession {
  if (!value || typeof value !== 'object') throw new Error('Invalid Work Session record.');
  const item = value as Partial<WorkSession>;
  if (
    item.version !== 1 ||
    typeof item.id !== 'string' ||
    !/^[0-9a-fA-F-]{36}$/.test(item.id) ||
    typeof item.principalId !== 'string' ||
    (item.status !== 'active' && item.status !== 'closed') ||
    typeof item.createdAt !== 'string' ||
    typeof item.updatedAt !== 'string' ||
    !item.capsule ||
    item.capsule.version !== 1
  ) {
    throw new Error('Invalid Work Session record.');
  }
  return item as WorkSession;
}

export class WorkSessionStore {
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly file: string;
  private readonly now: () => Date;

  constructor(
    private readonly principalIdSource: PrincipalIdSource = 'unknown',
    options: WorkSessionStoreOptions = {}
  ) {
    this.file = options.file ?? path.join(setupConfigDir(), 'work-sessions.json');
    this.now = options.now ?? (() => new Date());
  }

  private principalId(): string {
    const raw = typeof this.principalIdSource === 'function'
      ? this.principalIdSource()
      : this.principalIdSource;
    return raw.trim() || 'unknown';
  }

  private async load(): Promise<WorkSessionFileV1> {
    try {
      const parsed = JSON.parse((await fs.readFile(this.file, 'utf8')).replace(/^\uFEFF/, '')) as Partial<WorkSessionFileV1>;
      if (parsed.version !== 1 || !Array.isArray(parsed.sessions)) {
        throw new Error(`Invalid Work Session store at '${this.file}'.`);
      }
      return { version: 1, sessions: parsed.sessions.map(validateSession) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, sessions: [] };
      throw error;
    }
  }

  private async save(state: WorkSessionFileV1): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temp, this.file);
    if (process.platform !== 'win32') await fs.chmod(this.file, 0o600);
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail;
    let release!: () => void;
    this.mutationTail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async create(input: WorkSessionCreateInput = {}): Promise<WorkSession> {
    const principalId = this.principalId();
    const name = boundedText(input.name, 'name', 128);
    const workspace = boundedText(input.workspace, 'workspace', 128);
    const projectPath = boundedText(input.projectPath, 'projectPath', 1024);
    const objective = boundedText(input.objective, 'objective', 2048);

    return this.mutate(async () => {
      const state = await this.load();
      const timestamp = this.now().toISOString();
      const capsule: ContextCapsule = {
        version: 1,
        ...(workspace ? { project: { workspace, ...(projectPath ? { projectPath } : {}) } } : {}),
        ...(objective ? { currentObjective: objective } : {}),
        validatedFacts: [],
        blockers: [],
        decisions: [],
        pendingActions: []
      };
      const session: WorkSession = {
        version: 1,
        id: randomUUID(),
        principalId,
        status: 'active',
        ...(name ? { name } : {}),
        createdAt: timestamp,
        updatedAt: timestamp,
        capsule
      };
      state.sessions.push(session);
      await this.save(state);
      return structuredClone(session);
    });
  }

  async resume(sessionId: string): Promise<WorkSession> {
    const normalized = sessionId.trim();
    if (!normalized) throw new Error('Work Session id must not be empty.');
    const principalId = this.principalId();
    const state = await this.load();
    const session = state.sessions.find(item =>
      item.id === normalized &&
      item.principalId === principalId &&
      item.status === 'active'
    );
    if (!session) {
      throw new Error(`Unknown active Work Session '${normalized}'.`);
    }
    return structuredClone(session);
  }

  async list(includeClosed = false): Promise<WorkSession[]> {
    const principalId = this.principalId();
    const state = await this.load();
    return state.sessions
      .filter(item => item.principalId === principalId && (includeClosed || item.status === 'active'))
      .map(item => structuredClone(item));
  }
}
