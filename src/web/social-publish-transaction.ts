import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setupConfigDir } from '../setup/settings.js';
import type { SocialPlatform } from './domain-policy.js';

export type SocialMutation = 'upload' | 'metadata' | 'schedule' | 'publish' | 'verify';
export type SocialTransactionPhase =
  | 'planned'
  | 'upload-applying'
  | 'uploaded'
  | 'metadata-applying'
  | 'metadata-applied'
  | 'schedule-applying'
  | 'scheduled'
  | 'publish-applying'
  | 'published'
  | 'verify-applying'
  | 'verified'
  | 'blocked';

export interface SocialTransactionEvidence {
  observedAt: string;
  remoteId?: string;
  url?: string;
  note?: string;
  scheduleAt?: string;
  fields?: string[];
}

export interface SocialPublishTransaction {
  version: 1;
  id: string;
  idempotencyKey: string;
  platform: SocialPlatform;
  planSha256: string;
  sourceSha256: string;
  principalId: string;
  createdWorkSessionId: string;
  phase: SocialTransactionPhase;
  createdAt: string;
  updatedAt: string;
  attempts: Partial<Record<SocialMutation, number>>;
  evidence: Partial<Record<SocialMutation, SocialTransactionEvidence>>;
  blocker?: { code: string; reason: string; at: string };
}

const SHA_RE = /^[a-f0-9]{64}$/;
const ID_RE = /^[a-f0-9]{64}$/;
const PHASE_ORDER: Record<SocialTransactionPhase, number> = {
  planned: 0,
  'upload-applying': 1,
  uploaded: 2,
  'metadata-applying': 3,
  'metadata-applied': 4,
  'schedule-applying': 5,
  scheduled: 6,
  'publish-applying': 7,
  published: 8,
  'verify-applying': 9,
  verified: 10,
  blocked: 99
};

const MUTATION_PHASES: Record<SocialMutation, { applying: SocialTransactionPhase; completed: SocialTransactionPhase }> = {
  upload: { applying: 'upload-applying', completed: 'uploaded' },
  metadata: { applying: 'metadata-applying', completed: 'metadata-applied' },
  schedule: { applying: 'schedule-applying', completed: 'scheduled' },
  publish: { applying: 'publish-applying', completed: 'published' },
  verify: { applying: 'verify-applying', completed: 'verified' }
};

function transactionId(platform: SocialPlatform, planSha256: string): string {
  return createHash('sha256').update(`social-publish:v1:${platform}:${planSha256}`).digest('hex');
}

function boundedText(value: string | undefined, max: number): string | undefined {
  const clean = value?.trim().replace(/[\r\n\t]+/g, ' ');
  return clean ? clean.slice(0, max) : undefined;
}

function sanitizeEvidence(value: SocialTransactionEvidence): SocialTransactionEvidence {
  const observed = Date.parse(value.observedAt);
  if (!Number.isFinite(observed)) throw new Error('Social transaction evidence observedAt must be an ISO timestamp.');
  const remoteId = boundedText(value.remoteId, 256);
  const url = boundedText(value.url, 2048);
  const note = boundedText(value.note, 1024);
  const scheduleAt = boundedText(value.scheduleAt, 128);
  const fields = value.fields?.map(item => boundedText(item, 128)).filter((item): item is string => Boolean(item)).slice(0, 64);
  return {
    observedAt: new Date(observed).toISOString(),
    ...(remoteId ? { remoteId } : {}),
    ...(url ? { url } : {}),
    ...(note ? { note } : {}),
    ...(scheduleAt ? { scheduleAt } : {}),
    ...(fields?.length ? { fields } : {})
  };
}

function validateRecord(value: SocialPublishTransaction, expectedId?: string): SocialPublishTransaction {
  if (value.version !== 1 || !ID_RE.test(value.id)) throw new Error('Social publish transaction record is invalid.');
  if (expectedId && value.id !== expectedId) throw new Error('Social publish transaction id mismatch.');
  if (!SHA_RE.test(value.planSha256) || !SHA_RE.test(value.sourceSha256)) throw new Error('Social publish transaction digest is invalid.');
  if (!['youtube', 'tiktok'].includes(value.platform)) throw new Error('Social publish transaction platform is invalid.');
  if (!(value.phase in PHASE_ORDER)) throw new Error('Social publish transaction phase is invalid.');
  return value;
}

async function atomicWrite(file: string, value: SocialPublishTransaction): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temp, file);
}

export class SocialPublishTransactionStore {
  constructor(private readonly stateRoot = path.join(setupConfigDir(), 'runtime', 'social-publishing')) {}

  private file(id: string): string {
    if (!ID_RE.test(id)) throw new Error('Invalid social publish transaction id.');
    return path.join(this.stateRoot, id.slice(0, 2), `${id}.json`);
  }

  private lockFile(id: string): string {
    return `${this.file(id)}.lock`;
  }

  private async withLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const lock = this.lockFile(id);
    await fs.mkdir(path.dirname(lock), { recursive: true });
    let handle: Awaited<ReturnType<typeof fs.open>>;
    try {
      handle = await fs.open(lock, 'wx', 0o600);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') throw new Error('SOCIAL_TRANSACTION_BUSY: another process is updating this publish transaction.');
      throw error;
    }
    try {
      return await operation();
    } finally {
      await handle.close().catch(() => {});
      await fs.unlink(lock).catch(() => {});
    }
  }

  async ensure(input: {
    platform: SocialPlatform;
    planSha256: string;
    sourceSha256: string;
    principalId: string;
    workSessionId: string;
  }): Promise<{ transaction: SocialPublishTransaction; created: boolean }> {
    if (!SHA_RE.test(input.planSha256) || !SHA_RE.test(input.sourceSha256)) throw new Error('Social publish transaction requires SHA-256 plan/source digests.');
    const id = transactionId(input.platform, input.planSha256);
    return await this.withLock(id, async () => {
      const file = this.file(id);
      try {
        const existing = validateRecord(JSON.parse(await fs.readFile(file, 'utf8')) as SocialPublishTransaction, id);
        if (existing.platform !== input.platform || existing.planSha256 !== input.planSha256 || existing.sourceSha256 !== input.sourceSha256) {
          throw new Error('SOCIAL_TRANSACTION_COLLISION: existing record does not match the requested plan/source.');
        }
        if (existing.principalId !== input.principalId) {
          throw new Error('SOCIAL_TRANSACTION_OWNER_MISMATCH: existing transaction belongs to a different principal.');
        }
        return { transaction: existing, created: false };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const now = new Date().toISOString();
      const transaction: SocialPublishTransaction = {
        version: 1,
        id,
        idempotencyKey: id,
        platform: input.platform,
        planSha256: input.planSha256,
        sourceSha256: input.sourceSha256,
        principalId: input.principalId.slice(0, 256),
        createdWorkSessionId: input.workSessionId,
        phase: 'planned',
        createdAt: now,
        updatedAt: now,
        attempts: {},
        evidence: {}
      };
      await atomicWrite(file, transaction);
      return { transaction, created: true };
    });
  }

  async read(id: string): Promise<SocialPublishTransaction> {
    return validateRecord(JSON.parse(await fs.readFile(this.file(id), 'utf8')) as SocialPublishTransaction, id);
  }

  isCompleted(transaction: SocialPublishTransaction, mutation: SocialMutation): boolean {
    return PHASE_ORDER[transaction.phase] >= PHASE_ORDER[MUTATION_PHASES[mutation].completed] && transaction.phase !== 'blocked';
  }

  async startMutation(id: string, mutation: SocialMutation): Promise<{ transaction: SocialPublishTransaction; alreadyCompleted: boolean }> {
    return await this.withLock(id, async () => {
      const current = await this.read(id);
      const phases = MUTATION_PHASES[mutation];
      if (current.phase === phases.applying) {
        throw new Error(`SOCIAL_TRANSACTION_RECONCILE_REQUIRED: ${mutation} may have reached the remote platform before interruption; inspect remote state before retrying.`);
      }
      if (current.phase === 'blocked') throw new Error(`SOCIAL_TRANSACTION_BLOCKED: ${current.blocker?.reason ?? 'transaction is blocked'}`);
      if (this.isCompleted(current, mutation)) return { transaction: current, alreadyCompleted: true };

      const previousMutation = mutation === 'upload' ? undefined
        : mutation === 'metadata' ? 'upload'
          : mutation === 'schedule' ? 'metadata'
            : mutation === 'publish' ? 'metadata'
              : 'publish';
      if (previousMutation && !this.isCompleted(current, previousMutation)) {
        throw new Error(`SOCIAL_TRANSACTION_PHASE_ORDER: ${mutation} cannot start before ${previousMutation} completes.`);
      }
      const next: SocialPublishTransaction = {
        ...current,
        phase: phases.applying,
        updatedAt: new Date().toISOString(),
        attempts: { ...current.attempts, [mutation]: (current.attempts[mutation] ?? 0) + 1 }
      };
      await atomicWrite(this.file(id), next);
      return { transaction: next, alreadyCompleted: false };
    });
  }

  async completeMutation(id: string, mutation: SocialMutation, evidence: SocialTransactionEvidence): Promise<SocialPublishTransaction> {
    return await this.withLock(id, async () => {
      const current = await this.read(id);
      const phases = MUTATION_PHASES[mutation];
      if (this.isCompleted(current, mutation)) return current;
      if (current.phase !== phases.applying) {
        throw new Error(`SOCIAL_TRANSACTION_PHASE_MISMATCH: expected ${phases.applying}, found ${current.phase}.`);
      }
      const next: SocialPublishTransaction = {
        ...current,
        phase: phases.completed,
        updatedAt: new Date().toISOString(),
        evidence: { ...current.evidence, [mutation]: sanitizeEvidence(evidence) }
      };
      await atomicWrite(this.file(id), next);
      return next;
    });
  }

  async reconcileMutation(id: string, mutation: SocialMutation, outcome: 'applied' | 'not-applied', evidence: SocialTransactionEvidence): Promise<SocialPublishTransaction> {
    return await this.withLock(id, async () => {
      const current = await this.read(id);
      const phases = MUTATION_PHASES[mutation];
      if (current.phase !== phases.applying) {
        throw new Error(`SOCIAL_TRANSACTION_RECONCILE_PHASE_MISMATCH: expected ${phases.applying}, found ${current.phase}.`);
      }
      const next: SocialPublishTransaction = outcome === 'applied'
        ? {
            ...current,
            phase: phases.completed,
            updatedAt: new Date().toISOString(),
            evidence: { ...current.evidence, [mutation]: sanitizeEvidence(evidence) }
          }
        : {
            ...current,
            phase: mutation === 'upload' ? 'planned'
              : mutation === 'metadata' ? 'uploaded'
                : mutation === 'schedule' ? 'metadata-applied'
                  : mutation === 'publish' ? 'metadata-applied'
                    : 'published',
            updatedAt: new Date().toISOString(),
            evidence: { ...current.evidence, [mutation]: sanitizeEvidence(evidence) }
          };
      await atomicWrite(this.file(id), next);
      return next;
    });
  }

  async block(id: string, code: string, reason: string): Promise<SocialPublishTransaction> {
    return await this.withLock(id, async () => {
      const current = await this.read(id);
      const now = new Date().toISOString();
      const next: SocialPublishTransaction = {
        ...current,
        phase: 'blocked',
        updatedAt: now,
        blocker: {
          code: boundedText(code, 128) ?? 'blocked',
          reason: boundedText(reason, 1024) ?? 'blocked',
          at: now
        }
      };
      await atomicWrite(this.file(id), next);
      return next;
    });
  }
}
