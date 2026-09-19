import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setupConfigDir } from './setup/settings.js';
import type { WorkSession, WorkSessionStatus, WorkSessionStore } from './work-session.js';

export type ProjectSessionGroupStatus = 'active' | 'closed';

export interface ProjectSessionGroup {
  version: 1;
  id: string;
  principalId: string;
  status: ProjectSessionGroupStatus;
  name?: string;
  workspace: string;
  projectPath: string;
  memberSessionIds: string[];
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
}

export interface ProjectSessionGroupMemberView {
  sessionId: string;
  status: WorkSessionStatus | 'unavailable';
  name?: string;
  role?: string;
  currentObjective?: string;
}

export interface ProjectSessionGroupView {
  group: ProjectSessionGroup;
  members: ProjectSessionGroupMemberView[];
  authority: 'coordination-only';
  executionActive: false;
}

interface ProjectSessionGroupFileV1 {
  version: 1;
  groups: ProjectSessionGroup[];
}

type PrincipalIdSource = string | (() => string);

export interface ProjectSessionGroupStoreOptions {
  file?: string;
  now?: () => Date;
  terminalRetentionMs?: number;
  gcMaxRecords?: number;
  maxGroups?: number;
  maxMembers?: number;
}

const DEFAULT_TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_GC_MAX_RECORDS = 32;
const DEFAULT_MAX_GROUPS = 128;
const DEFAULT_MAX_MEMBERS = 16;

function boundedText(value: string | undefined, field: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > max || normalized.includes('\0')) {
    throw new Error(field + ' must be non-empty text of at most ' + max + ' characters.');
  }
  return normalized;
}

function validIso(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function validSessionId(value: string): boolean {
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/.test(value);
}

function validateGroup(value: unknown): ProjectSessionGroup {
  if (!value || typeof value !== 'object') throw new Error('Invalid Project Session Group record.');
  const item = value as Partial<ProjectSessionGroup>;
  if (
    item.version !== 1 ||
    typeof item.id !== 'string' ||
    !validSessionId(item.id) ||
    typeof item.principalId !== 'string' ||
    !item.principalId.trim() ||
    (item.status !== 'active' && item.status !== 'closed') ||
    (item.name !== undefined && (typeof item.name !== 'string' || !item.name.trim() || item.name.length > 128)) ||
    typeof item.workspace !== 'string' ||
    !item.workspace.trim() ||
    item.workspace.length > 128 ||
    typeof item.projectPath !== 'string' ||
    !item.projectPath.trim() ||
    item.projectPath.length > 1024 ||
    !Array.isArray(item.memberSessionIds) ||
    item.memberSessionIds.length < 1 ||
    item.memberSessionIds.length > 64 ||
    !item.memberSessionIds.every(id => typeof id === 'string' && validSessionId(id)) ||
    new Set(item.memberSessionIds).size !== item.memberSessionIds.length ||
    !validIso(item.createdAt) ||
    !validIso(item.updatedAt)
  ) {
    throw new Error('Invalid Project Session Group record.');
  }
  if (
    (item.status === 'closed' && !validIso(item.closedAt)) ||
    (item.status === 'active' && item.closedAt !== undefined)
  ) {
    throw new Error('Invalid Project Session Group closedAt lifecycle state.');
  }
  return item as ProjectSessionGroup;
}

function normalizeProjectPath(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/\/+$/, '');
}

export class ProjectSessionGroupStore {
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly file: string;
  private readonly now: () => Date;
  private readonly terminalRetentionMs: number;
  private readonly gcMaxRecords: number;
  readonly maxGroups: number;
  readonly maxMembers: number;

  constructor(
    private readonly principalIdSource: PrincipalIdSource = 'unknown',
    options: ProjectSessionGroupStoreOptions = {}
  ) {
    this.file = options.file ?? path.join(setupConfigDir(), 'project-session-groups.json');
    this.now = options.now ?? (() => new Date());
    this.terminalRetentionMs = options.terminalRetentionMs ?? DEFAULT_TERMINAL_RETENTION_MS;
    this.gcMaxRecords = Math.max(1, Math.min(options.gcMaxRecords ?? DEFAULT_GC_MAX_RECORDS, 256));
    this.maxGroups = Math.max(1, Math.min(options.maxGroups ?? DEFAULT_MAX_GROUPS, 512));
    this.maxMembers = Math.max(1, Math.min(options.maxMembers ?? DEFAULT_MAX_MEMBERS, 64));
  }

  private principalId(): string {
    const raw = typeof this.principalIdSource === 'function'
      ? this.principalIdSource()
      : this.principalIdSource;
    return raw.trim() || 'unknown';
  }

  private async load(): Promise<ProjectSessionGroupFileV1> {
    try {
      const parsed = JSON.parse((await fs.readFile(this.file, 'utf8')).replace(/^\uFEFF/, '')) as Partial<ProjectSessionGroupFileV1>;
      if (parsed.version !== 1 || !Array.isArray(parsed.groups)) {
        throw new Error('Invalid Project Session Group store at ' + this.file + '.');
      }
      return { version: 1, groups: parsed.groups.map(validateGroup) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, groups: [] };
      throw error;
    }
  }

  private async save(state: ProjectSessionGroupFileV1): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temp = this.file + '.' + process.pid + '.' + Date.now() + '.tmp';
    await fs.writeFile(temp, JSON.stringify(state, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
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

  private owned(state: ProjectSessionGroupFileV1, groupId: string): ProjectSessionGroup {
    const group = state.groups.find(item => item.id === groupId && item.principalId === this.principalId());
    if (!group) throw new Error('Unknown Project Session Group ' + groupId + '.');
    return group;
  }

  private assertActive(group: ProjectSessionGroup): void {
    if (group.status !== 'active') throw new Error('Project Session Group ' + group.id + ' is closed.');
  }

  private assertMembers(memberSessionIds: string[]): string[] {
    if (memberSessionIds.length < 1 || memberSessionIds.length > this.maxMembers) {
      throw new Error('Project Session Group requires between 1 and ' + this.maxMembers + ' Work Sessions.');
    }
    const normalized = memberSessionIds.map(id => id.trim());
    if (!normalized.every(validSessionId)) throw new Error('Project Session Group member ids must be Work Session UUIDs.');
    if (new Set(normalized).size !== normalized.length) throw new Error('Project Session Group member ids must be unique.');
    return normalized;
  }

  private assertUnclaimedActiveMembership(
    state: ProjectSessionGroupFileV1,
    memberSessionIds: string[],
    exceptGroupId?: string
  ): void {
    for (const group of state.groups) {
      if (group.status !== 'active' || group.id === exceptGroupId || group.principalId !== this.principalId()) continue;
      const overlap = memberSessionIds.find(id => group.memberSessionIds.includes(id));
      if (overlap) {
        throw new Error('Work Session ' + overlap + ' already belongs to active Project Session Group ' + group.id + '.');
      }
    }
  }

  async create(input: {
    name?: string;
    workspace: string;
    projectPath: string;
    memberSessionIds: string[];
  }): Promise<ProjectSessionGroup> {
    const name = boundedText(input.name, 'name', 128);
    const workspace = boundedText(input.workspace, 'workspace', 128)!;
    const projectPath = boundedText(normalizeProjectPath(input.projectPath), 'projectPath', 1024)!;
    const memberSessionIds = this.assertMembers(input.memberSessionIds);

    return this.mutate(async () => {
      const state = await this.load();
      const ownedCount = state.groups.filter(item => item.principalId === this.principalId()).length;
      if (ownedCount >= this.maxGroups) {
        throw new Error('Project Session Group limit reached for the current principal.');
      }
      this.assertUnclaimedActiveMembership(state, memberSessionIds);
      const timestamp = this.now().toISOString();
      const group: ProjectSessionGroup = {
        version: 1,
        id: randomUUID(),
        principalId: this.principalId(),
        status: 'active',
        ...(name ? { name } : {}),
        workspace,
        projectPath,
        memberSessionIds,
        createdAt: timestamp,
        updatedAt: timestamp
      };
      state.groups.push(group);
      await this.save(state);
      return structuredClone(group);
    });
  }

  async addMember(groupId: string, sessionId: string): Promise<ProjectSessionGroup> {
    const [normalizedSessionId] = this.assertMembers([sessionId]);
    return this.mutate(async () => {
      const state = await this.load();
      const group = this.owned(state, groupId);
      this.assertActive(group);
      if (group.memberSessionIds.includes(normalizedSessionId)) return structuredClone(group);
      if (group.memberSessionIds.length >= this.maxMembers) {
        throw new Error('Project Session Group member limit reached.');
      }
      this.assertUnclaimedActiveMembership(state, [normalizedSessionId], group.id);
      group.memberSessionIds.push(normalizedSessionId);
      group.updatedAt = this.now().toISOString();
      await this.save(state);
      return structuredClone(group);
    });
  }

  async removeMember(groupId: string, sessionId: string): Promise<ProjectSessionGroup> {
    const [normalizedSessionId] = this.assertMembers([sessionId]);
    return this.mutate(async () => {
      const state = await this.load();
      const group = this.owned(state, groupId);
      this.assertActive(group);
      if (!group.memberSessionIds.includes(normalizedSessionId)) return structuredClone(group);
      if (group.memberSessionIds.length === 1) {
        throw new Error('Cannot remove the last Work Session from an active Project Session Group; close the group instead.');
      }
      group.memberSessionIds = group.memberSessionIds.filter(id => id !== normalizedSessionId);
      group.updatedAt = this.now().toISOString();
      await this.save(state);
      return structuredClone(group);
    });
  }

  async close(groupId: string): Promise<ProjectSessionGroup> {
    return this.mutate(async () => {
      const state = await this.load();
      const group = this.owned(state, groupId);
      if (group.status === 'closed') return structuredClone(group);
      const timestamp = this.now().toISOString();
      group.status = 'closed';
      group.closedAt = timestamp;
      group.updatedAt = timestamp;
      await this.save(state);
      return structuredClone(group);
    });
  }

  async get(groupId: string): Promise<ProjectSessionGroup> {
    const state = await this.load();
    return structuredClone(this.owned(state, groupId));
  }

  async list(includeClosed = false): Promise<ProjectSessionGroup[]> {
    const principalId = this.principalId();
    const state = await this.load();
    return state.groups
      .filter(item => item.principalId === principalId && (includeClosed || item.status === 'active'))
      .map(item => structuredClone(item));
  }

  async garbageCollect(): Promise<number> {
    return this.mutate(async () => {
      const state = await this.load();
      const nowMs = this.now().getTime();
      let removed = 0;
      state.groups = state.groups.filter(group => {
        if (removed >= this.gcMaxRecords || group.status !== 'closed') return true;
        const terminalAt = Date.parse(group.closedAt ?? group.updatedAt);
        if (nowMs - terminalAt < this.terminalRetentionMs) return true;
        removed += 1;
        return false;
      });
      if (removed > 0) await this.save(state);
      return removed;
    });
  }
}

export class ProjectSessionGroupService {
  constructor(
    private readonly store: ProjectSessionGroupStore,
    private readonly workSessions: WorkSessionStore
  ) {}

  private sessionProject(session: WorkSession): { workspace: string; projectPath: string } {
    const workspace = session.capsule.project?.workspace?.trim();
    const projectPath = session.capsule.project?.projectPath?.trim();
    if (!workspace || !projectPath) {
      throw new Error('Work Session ' + session.id + ' must have workspace and projectPath before joining a Project Session Group.');
    }
    return { workspace, projectPath: normalizeProjectPath(projectPath) };
  }

  private async activeSession(sessionId: string): Promise<WorkSession> {
    const session = await this.workSessions.inspect(sessionId, false);
    if (session.status === 'closing') {
      throw new Error('Work Session ' + sessionId + ' is closing and cannot join a Project Session Group.');
    }
    return session;
  }

  private async assertSameProject(
    sessionIds: string[],
    expected?: { workspace: string; projectPath: string }
  ): Promise<{ workspace: string; projectPath: string }> {
    let project = expected;
    for (const sessionId of sessionIds) {
      const session = await this.activeSession(sessionId);
      const current = this.sessionProject(session);
      if (!project) project = current;
      if (project.workspace !== current.workspace || project.projectPath !== current.projectPath) {
        throw new Error('All Project Session Group members must belong to the same workspace/projectPath.');
      }
    }
    if (!project) throw new Error('Project Session Group requires at least one Work Session.');
    return project;
  }

  private async view(group: ProjectSessionGroup): Promise<ProjectSessionGroupView> {
    const members = await Promise.all(group.memberSessionIds.map(async sessionId => {
      try {
        const session = await this.workSessions.inspect(sessionId, true);
        return {
          sessionId,
          status: session.status,
          ...(session.name ? { name: session.name } : {}),
          ...(session.capsule.role ? { role: session.capsule.role } : {}),
          ...(session.capsule.currentObjective ? { currentObjective: session.capsule.currentObjective } : {})
        } satisfies ProjectSessionGroupMemberView;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.startsWith('Unknown Work Session ')) {
          return { sessionId, status: 'unavailable' as const };
        }
        throw error;
      }
    }));
    return {
      group,
      members,
      authority: 'coordination-only',
      executionActive: false
    };
  }

  async create(input: { name?: string; sessionIds: string[] }): Promise<ProjectSessionGroupView> {
    const project = await this.assertSameProject(input.sessionIds);
    return this.view(await this.store.create({
      name: input.name,
      workspace: project.workspace,
      projectPath: project.projectPath,
      memberSessionIds: input.sessionIds
    }));
  }

  async addSession(groupId: string, sessionId: string): Promise<ProjectSessionGroupView> {
    const group = await this.store.get(groupId);
    if (group.status !== 'active') throw new Error('Project Session Group ' + groupId + ' is closed.');
    await this.assertSameProject([sessionId], { workspace: group.workspace, projectPath: group.projectPath });
    return this.view(await this.store.addMember(groupId, sessionId));
  }

  async removeSession(groupId: string, sessionId: string): Promise<ProjectSessionGroupView> {
    return this.view(await this.store.removeMember(groupId, sessionId));
  }

  async close(groupId: string): Promise<ProjectSessionGroupView> {
    return this.view(await this.store.close(groupId));
  }

  async get(groupId: string): Promise<ProjectSessionGroupView> {
    return this.view(await this.store.get(groupId));
  }

  async list(includeClosed = false): Promise<ProjectSessionGroupView[]> {
    return Promise.all((await this.store.list(includeClosed)).map(group => this.view(group)));
  }
}
