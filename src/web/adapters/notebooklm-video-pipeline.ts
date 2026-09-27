import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export type VideoProductionProfile =
  | 'tiktok_short'
  | 'youtube_long'
  | 'deep_tutorial'
  | 'comparison'
  | 'project_walkthrough';

export interface VideoPipelineJobInput {
  id?: string;
  focus: string;
  sources: string[];
}

export type VideoPipelineJobStatus = 'pending' | 'running' | 'ready' | 'failed' | 'rejected';

export interface VideoPipelineJobState {
  id: string;
  index: number;
  focus: string;
  sources: string[];
  status: VideoPipelineJobStatus;
  attempts: number;
  artifact?: Record<string, unknown>;
  quality?: {
    passed: boolean;
    reasons: string[];
    checkedAt: string;
  };
  lastError?: string;
  updatedAt: string;
}

export interface VideoPipelineQueueState {
  version: 1;
  queueId: string;
  notebookId: string;
  profile: VideoProductionProfile;
  planHash: string;
  createdAt: string;
  updatedAt: string;
  jobs: VideoPipelineJobState[];
}

const PROFILE_GUIDANCE: Record<VideoProductionProfile, string> = {
  tiktok_short:
    'Create a concise vertical-friendly lesson. Start immediately with the concept, avoid repeated introductions, explain one focused idea, use a concrete example, and finish with one memorable takeaway.',
  youtube_long:
    'Create a long-form in-depth teaching video. Build the topic from fundamentals to implementation, compare alternatives where relevant, include engineering trade-offs, practical examples, common mistakes, and a structured conclusion. Do not compress the lesson into a short overview.',
  deep_tutorial:
    'Create a rigorous step-by-step technical tutorial. Explain prerequisites, internal mechanism, implementation sequence, diagnostics, failure modes, and verification. Prefer depth and correctness over broad coverage.',
  comparison:
    'Create a comparison-focused teaching video. Define each option, compare architecture, strengths, limitations, performance, compatibility, and concrete use cases. End with a neutral decision framework rather than a single universal winner.',
  project_walkthrough:
    'Create a project walkthrough from goal and architecture through implementation, testing, troubleshooting, and acceptance. Explain why each engineering decision was made and connect each step to observable results.'
};

export function applyProductionProfile(profile: VideoProductionProfile, focus: string, sources: string[]): string {
  const sourceLine = sources.length > 0
    ? `Use only the currently selected NotebookLM sources for this job: ${sources.join(' | ')}.`
    : '';
  return [PROFILE_GUIDANCE[profile], sourceLine, focus.trim()].filter(Boolean).join('\n\n').slice(0, 8_000);
}

export function videoPlanHash(notebookId: string, profile: VideoProductionProfile, jobs: VideoPipelineJobInput[]): string {
  const normalized = jobs.map((job, index) => ({
    id: (job.id ?? `video-${index + 1}`).trim(),
    focus: job.focus.trim(),
    sources: [...job.sources].map(item => item.trim()).sort((a, b) => a.localeCompare(b))
  }));
  return createHash('sha256')
    .update(JSON.stringify({ notebookId, profile, jobs: normalized }))
    .digest('hex');
}

function ownerKey(owner: { principalId: string; workSessionId: string }): string {
  return createHash('sha256').update(`${owner.principalId}\0${owner.workSessionId}`).digest('hex').slice(0, 32);
}

function safeQueueId(queueId: string): string {
  const normalized = queueId.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(normalized)) {
    throw new Error('NotebookLM video queueId must be 1-128 characters using letters, digits, dot, underscore or hyphen.');
  }
  return normalized;
}

export class NotebookLmVideoQueueStore {
  constructor(private readonly root = path.resolve(process.env.RWMCP_NOTEBOOKLM_QUEUE_DIR ?? 'runtime/notebooklm-video-queues')) {}

  private file(owner: { principalId: string; workSessionId: string }, queueId: string): string {
    return path.join(this.root, ownerKey(owner), `${safeQueueId(queueId)}.json`);
  }

  async load(owner: { principalId: string; workSessionId: string }, queueId: string): Promise<VideoPipelineQueueState | undefined> {
    const file = this.file(owner, queueId);
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as VideoPipelineQueueState;
      if (parsed.version !== 1 || parsed.queueId !== safeQueueId(queueId) || !Array.isArray(parsed.jobs)) {
        throw new Error('NotebookLM video queue state is invalid.');
      }
      let changed = false;
      for (const job of parsed.jobs) {
        if (job.status === 'running') {
          job.status = 'pending';
          job.lastError = 'Recovered after interrupted runtime; job returned to pending.';
          job.updatedAt = new Date().toISOString();
          changed = true;
        }
      }
      if (changed) await this.save(owner, parsed);
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async save(owner: { principalId: string; workSessionId: string }, state: VideoPipelineQueueState): Promise<void> {
    const file = this.file(owner, state.queueId);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    state.updatedAt = new Date().toISOString();
    await fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tmp, file);
  }

  create(
    queueId: string,
    notebookId: string,
    profile: VideoProductionProfile,
    planHash: string,
    jobs: VideoPipelineJobInput[]
  ): VideoPipelineQueueState {
    const now = new Date().toISOString();
    return {
      version: 1,
      queueId: safeQueueId(queueId),
      notebookId,
      profile,
      planHash,
      createdAt: now,
      updatedAt: now,
      jobs: jobs.map((job, index) => ({
        id: (job.id ?? `video-${index + 1}`).trim().slice(0, 128),
        index,
        focus: job.focus.trim().slice(0, 8_000),
        sources: [...new Set(job.sources.map(item => item.trim()).filter(Boolean))].slice(0, 32),
        status: 'pending',
        attempts: 0,
        updatedAt: now
      }))
    };
  }
}
