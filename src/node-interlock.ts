import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveResourceOwner, type ResourceOwnerSource } from './security/execution-context.js';
import { setupConfigDir } from './setup/settings.js';

export interface NodeInterlockRecord {
  version: 1;
  id: string;
  pid: number;
  principalId: string;
  workSessionId: string;
  kind: 'workflow';
  label: string;
  acquiredAt: string;
}

interface NodeInterlockFileV1 {
  version: 1;
  records: NodeInterlockRecord[];
}

export interface NodeInterlockStoreOptions {
  file?: string;
  now?: () => Date;
  pid?: number;
  pidAlive?: (pid: number) => boolean;
}

function defaultPidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class NodeInterlockStore {
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly file: string;
  private readonly now: () => Date;
  private readonly pid: number;
  private readonly pidAlive: (pid: number) => boolean;

  constructor(
    private readonly ownerSource: ResourceOwnerSource = 'unknown',
    options: NodeInterlockStoreOptions = {}
  ) {
    this.file = options.file ?? path.join(setupConfigDir(), 'runtime', 'work-session-interlocks.json');
    this.now = options.now ?? (() => new Date());
    this.pid = options.pid ?? process.pid;
    this.pidAlive = options.pidAlive ?? defaultPidAlive;
  }

  private async load(): Promise<NodeInterlockFileV1> {
    try {
      const parsed = JSON.parse((await fs.readFile(this.file, 'utf8')).replace(/^\uFEFF/, '')) as Partial<NodeInterlockFileV1>;
      if (parsed.version !== 1 || !Array.isArray(parsed.records)) {
        throw new Error(`Invalid Work Session interlock store at '${this.file}'.`);
      }
      const records = parsed.records.filter((record): record is NodeInterlockRecord =>
        Boolean(record) &&
        record.version === 1 &&
        typeof record.id === 'string' &&
        Number.isSafeInteger(record.pid) &&
        record.pid > 0 &&
        typeof record.principalId === 'string' &&
        typeof record.workSessionId === 'string' &&
        record.kind === 'workflow' &&
        typeof record.label === 'string' &&
        typeof record.acquiredAt === 'string'
      );
      return { version: 1, records };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, records: [] };
      throw error;
    }
  }

  private async save(state: NodeInterlockFileV1): Promise<void> {
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

  async reconcileStale(): Promise<number> {
    return this.mutate(async () => {
      const state = await this.load();
      const before = state.records.length;
      state.records = state.records.filter(record => this.pidAlive(record.pid));
      const removed = before - state.records.length;
      if (removed > 0) await this.save(state);
      return removed;
    });
  }

  async acquireWorkflow(label: string): Promise<NodeInterlockRecord> {
    const normalized = label.trim();
    if (!normalized || normalized.length > 256 || normalized.includes('\0')) {
      throw new Error('Node interlock workflow label must be 1..256 characters.');
    }
    const owner = resolveResourceOwner(this.ownerSource);
    return this.mutate(async () => {
      const state = await this.load();
      state.records = state.records.filter(record => this.pidAlive(record.pid));
      const record: NodeInterlockRecord = {
        version: 1,
        id: randomUUID(),
        pid: this.pid,
        principalId: owner.principalId,
        workSessionId: owner.workSessionId,
        kind: 'workflow',
        label: normalized,
        acquiredAt: this.now().toISOString()
      };
      state.records.push(record);
      await this.save(state);
      return structuredClone(record);
    });
  }

  async release(id: string): Promise<void> {
    const owner = resolveResourceOwner(this.ownerSource);
    await this.mutate(async () => {
      const state = await this.load();
      const index = state.records.findIndex(record =>
        record.id === id &&
        record.pid === this.pid &&
        record.principalId === owner.principalId &&
        record.workSessionId === owner.workSessionId
      );
      if (index < 0) throw new Error(`Unknown node interlock '${id}'.`);
      state.records.splice(index, 1);
      await this.save(state);
    });
  }

  async listOwned(): Promise<NodeInterlockRecord[]> {
    const owner = resolveResourceOwner(this.ownerSource);
    const state = await this.load();
    return state.records
      .filter(record =>
        this.pidAlive(record.pid) &&
        record.principalId === owner.principalId &&
        record.workSessionId === owner.workSessionId
      )
      .map(record => structuredClone(record));
  }

  async listActive(): Promise<NodeInterlockRecord[]> {
    const state = await this.load();
    return state.records.filter(record => this.pidAlive(record.pid)).map(record => structuredClone(record));
  }
}
