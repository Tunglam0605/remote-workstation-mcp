import fs from 'node:fs/promises';
import path from 'node:path';
import { loadSetupSettings, setupConfigDir, type ExecutionMode, type SetupSettings } from './setup/settings.js';

export type ExecutionPolicySource = 'owner-default' | 'work-session-override' | 'fallback-latch';

interface SessionOverride {
  mode: ExecutionMode;
  setAt: string;
}

interface ExecutionPolicyStateV1 {
  version: 1;
  fallback?: { active: boolean; reason?: string; detail?: string; activatedAt?: string };
  daily?: { date: string; codexTasks: number };
  sessionCodexTasks?: Record<string, number>;
  overrides?: Record<string, SessionOverride>;
  sessionFallbacks?: Record<string, { reason: string; detail?: string; activatedAt: string }>;
}

export interface ExecutionPolicyStatus {
  configuredMode: ExecutionMode;
  effectiveMode: ExecutionMode;
  source: ExecutionPolicySource;
  codexEnabled: boolean;
  allowChatOverride: boolean;
  codexFallback: 'rwmcp-only' | 'stop';
  fallbackActive: boolean;
  fallbackReason?: string;
  fallbackDetail?: string;
  fallbackActivatedAt?: string;
  workSessionId?: string;
  sessionOverride?: ExecutionMode;
  codexTasksToday: number;
  codexTasksThisSession: number;
  maxCodexTasksPerDay: number;
  maxCodexTasksPerSession: number;
  activeSessionOverrides: number;
  activeSessionFallbacks: number;
}

export interface ExecutionPolicyServiceOptions {
  file?: string;
  now?: () => Date;
  loadSettings?: () => Promise<SetupSettings>;
}

function boundedDetail(value: string | undefined, max = 512): string | undefined {
  const normalized = value?.trim().replace(/\s+/g, ' ').slice(0, max);
  return normalized || undefined;
}

function validMode(value: unknown): value is ExecutionMode {
  return value === 'rwmcp-only' || value === 'codex-only' || value === 'both';
}

export class ExecutionPolicyService {
  private readonly file: string;
  private readonly now: () => Date;
  private readonly loadSettings: () => Promise<SetupSettings>;
  private mutationTail: Promise<void> = Promise.resolve();

  async settings(): Promise<SetupSettings> {
    return await this.loadSettings();
  }

  constructor(options: ExecutionPolicyServiceOptions = {}) {
    this.file = options.file ?? path.join(setupConfigDir(), 'execution-policy-state.json');
    this.now = options.now ?? (() => new Date());
    this.loadSettings = options.loadSettings ?? (() => loadSetupSettings());
  }

  private empty(): ExecutionPolicyStateV1 {
    return { version: 1, fallback: { active: false }, sessionCodexTasks: {}, overrides: {}, sessionFallbacks: {} };
  }

  private async load(): Promise<ExecutionPolicyStateV1> {
    try {
      const raw = JSON.parse((await fs.readFile(this.file, 'utf8')).replace(/^\uFEFF/, '')) as Partial<ExecutionPolicyStateV1>;
      if (raw.version !== 1) throw new Error('Invalid execution policy state version.');

      const overrides: Record<string, SessionOverride> = {};
      for (const [sessionId, entry] of Object.entries(raw.overrides ?? {})) {
        if (!entry || !validMode(entry.mode) || typeof entry.setAt !== 'string') continue;
        overrides[sessionId] = { mode: entry.mode, setAt: entry.setAt };
      }

      const sessionCodexTasks: Record<string, number> = {};
      for (const [sessionId, count] of Object.entries(raw.sessionCodexTasks ?? {})) {
        if (Number.isSafeInteger(count) && count >= 0) sessionCodexTasks[sessionId] = count;
      }

      const sessionFallbacks: Record<string, { reason: string; detail?: string; activatedAt: string }> = {};
      for (const [sessionId, entry] of Object.entries(raw.sessionFallbacks ?? {})) {
        if (!entry || typeof entry.reason !== 'string' || typeof entry.activatedAt !== 'string') continue;
        const reason = boundedDetail(entry.reason, 128);
        const detail = boundedDetail(entry.detail);
        if (!reason) continue;
        sessionFallbacks[sessionId] = {
          reason,
          ...(detail ? { detail } : {}),
          activatedAt: entry.activatedAt
        };
      }

      const reason = boundedDetail(raw.fallback?.reason, 128);
      const detail = boundedDetail(raw.fallback?.detail);
      return {
        version: 1,
        fallback: {
          active: raw.fallback?.active === true,
          ...(reason ? { reason } : {}),
          ...(detail ? { detail } : {}),
          ...(typeof raw.fallback?.activatedAt === 'string' ? { activatedAt: raw.fallback.activatedAt } : {})
        },
        ...(raw.daily &&
          typeof raw.daily.date === 'string' &&
          Number.isSafeInteger(raw.daily.codexTasks) &&
          raw.daily.codexTasks >= 0
          ? { daily: { date: raw.daily.date, codexTasks: raw.daily.codexTasks } }
          : {}),
        sessionCodexTasks,
        overrides,
        sessionFallbacks
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return this.empty();
      throw error;
    }
  }

  private async save(state: ExecutionPolicyStateV1): Promise<void> {
    const sessionEntries = Object.entries(state.sessionCodexTasks ?? {});
    if (sessionEntries.length > 256) state.sessionCodexTasks = Object.fromEntries(sessionEntries.slice(-256));
    const overrideEntries = Object.entries(state.overrides ?? {});
    if (overrideEntries.length > 256) state.overrides = Object.fromEntries(overrideEntries.slice(-256));
    const fallbackEntries = Object.entries(state.sessionFallbacks ?? {});
    if (fallbackEntries.length > 256) state.sessionFallbacks = Object.fromEntries(fallbackEntries.slice(-256));

    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temp, this.file);
    if (process.platform !== 'win32') await fs.chmod(this.file, 0o600);
  }

  private async mutate<T>(operation: (state: ExecutionPolicyStateV1) => Promise<T> | T): Promise<T> {
    const previous = this.mutationTail;
    let release!: () => void;
    this.mutationTail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      const state = await this.load();
      const result = await operation(state);
      await this.save(state);
      return result;
    } finally {
      release();
    }
  }

  private today(): string {
    return this.now().toISOString().slice(0, 10);
  }

  private normalizeDaily(state: ExecutionPolicyStateV1): { date: string; codexTasks: number } {
    const date = this.today();
    if (!state.daily || state.daily.date !== date) state.daily = { date, codexTasks: 0 };
    return state.daily;
  }

  async status(workSessionId?: string): Promise<ExecutionPolicyStatus> {
    const [settings, state] = await Promise.all([this.loadSettings(), this.load()]);
    const configuredMode = settings.execution.defaultMode;
    const sessionOverride = workSessionId ? state.overrides?.[workSessionId]?.mode : undefined;
    const globalFallbackActive = state.fallback?.active === true && settings.execution.codexFallback === 'rwmcp-only';
    const sessionFallback = workSessionId && settings.execution.codexFallback === 'rwmcp-only'
      ? state.sessionFallbacks?.[workSessionId]
      : undefined;
    const fallbackActive = globalFallbackActive || Boolean(sessionFallback);

    let effectiveMode: ExecutionMode = configuredMode;
    let source: ExecutionPolicySource = 'owner-default';

    if (settings.execution.allowChatOverride && sessionOverride) {
      effectiveMode = sessionOverride;
      source = 'work-session-override';
    }
    if (fallbackActive) {
      effectiveMode = 'rwmcp-only';
      source = 'fallback-latch';
    }
    if (!settings.execution.codexEnabled && effectiveMode !== 'rwmcp-only') {
      effectiveMode = 'rwmcp-only';
      source = 'owner-default';
    }

    const codexTasksToday = state.daily?.date === this.today() ? state.daily.codexTasks : 0;
    return {
      configuredMode,
      effectiveMode,
      source,
      codexEnabled: settings.execution.codexEnabled,
      allowChatOverride: settings.execution.allowChatOverride,
      codexFallback: settings.execution.codexFallback,
      fallbackActive,
      ...(globalFallbackActive && state.fallback?.reason
        ? { fallbackReason: state.fallback.reason }
        : sessionFallback?.reason ? { fallbackReason: sessionFallback.reason } : {}),
      ...(globalFallbackActive && state.fallback?.detail
        ? { fallbackDetail: state.fallback.detail }
        : sessionFallback?.detail ? { fallbackDetail: sessionFallback.detail } : {}),
      ...(globalFallbackActive && state.fallback?.activatedAt
        ? { fallbackActivatedAt: state.fallback.activatedAt }
        : sessionFallback?.activatedAt ? { fallbackActivatedAt: sessionFallback.activatedAt } : {}),
      ...(workSessionId ? { workSessionId } : {}),
      ...(sessionOverride ? { sessionOverride } : {}),
      codexTasksToday,
      codexTasksThisSession: workSessionId ? (state.sessionCodexTasks?.[workSessionId] ?? 0) : 0,
      maxCodexTasksPerDay: settings.execution.maxCodexTasksPerDay,
      maxCodexTasksPerSession: settings.execution.maxCodexTasksPerSession,
      activeSessionOverrides: Object.keys(state.overrides ?? {}).length,
      activeSessionFallbacks: Object.keys(state.sessionFallbacks ?? {}).length
    };
  }

  async setSessionOverride(workSessionId: string, mode: ExecutionMode | null): Promise<ExecutionPolicyStatus> {
    const settings = await this.loadSettings();
    if (!settings.execution.allowChatOverride) {
      throw new Error('EXECUTION_POLICY_CHAT_OVERRIDE_DISABLED: owner disabled chat/session execution overrides in Control Center.');
    }
    await this.mutate(state => {
      state.overrides ??= {};
      if (mode === null) delete state.overrides[workSessionId];
      else state.overrides[workSessionId] = { mode, setAt: this.now().toISOString() };
    });
    return await this.status(workSessionId);
  }

  async clearSessionOverrides(): Promise<ExecutionPolicyStatus> {
    await this.mutate(state => { state.overrides = {}; });
    return await this.status();
  }

  async beforeCodexDispatch(workSessionId: string): Promise<ExecutionPolicyStatus> {
    const status = await this.status(workSessionId);
    if (!status.codexEnabled || status.effectiveMode === 'rwmcp-only') {
      throw new Error('EXECUTION_POLICY_RWMCP_ONLY: Codex worker dispatch is disabled by the effective execution policy.');
    }
    if (status.maxCodexTasksPerSession > 0 && status.codexTasksThisSession >= status.maxCodexTasksPerSession) {
      await this.activateSessionFallback(workSessionId, 'session-budget', 'Codex task budget for this Work Session was reached.');
      const after = await this.status(workSessionId);
      throw new Error(after.fallbackActive
        ? 'CODEX_FALLBACK_ACTIVE: session Codex task budget reached; effective mode switched to rwmcp-only.'
        : 'CODEX_BUDGET_REACHED: session Codex task budget reached; fallback policy is stop.');
    }
    if (status.maxCodexTasksPerDay > 0 && status.codexTasksToday >= status.maxCodexTasksPerDay) {
      await this.activateFallback('daily-budget', 'Daily Codex task budget was reached.');
      const after = await this.status(workSessionId);
      throw new Error(after.fallbackActive
        ? 'CODEX_FALLBACK_ACTIVE: daily Codex task budget reached; effective mode switched to rwmcp-only.'
        : 'CODEX_BUDGET_REACHED: daily Codex task budget reached; fallback policy is stop.');
    }

    await this.mutate(state => {
      const daily = this.normalizeDaily(state);
      daily.codexTasks += 1;
      state.sessionCodexTasks ??= {};
      state.sessionCodexTasks[workSessionId] = (state.sessionCodexTasks[workSessionId] ?? 0) + 1;
    });
    return await this.status(workSessionId);
  }

  async activateSessionFallback(workSessionId: string, reason: string, detail?: string): Promise<void> {
    const settings = await this.loadSettings();
    if (settings.execution.codexFallback !== 'rwmcp-only') return;
    const safeReason = boundedDetail(reason, 128);
    const safeDetail = boundedDetail(detail);
    if (!safeReason) return;
    await this.mutate(state => {
      state.sessionFallbacks ??= {};
      state.sessionFallbacks[workSessionId] = {
        reason: safeReason,
        ...(safeDetail ? { detail: safeDetail } : {}),
        activatedAt: this.now().toISOString()
      };
    });
  }

  async activateFallback(reason: string, detail?: string): Promise<void> {
    const settings = await this.loadSettings();
    if (settings.execution.codexFallback !== 'rwmcp-only') return;
    const safeReason = boundedDetail(reason, 128);
    const safeDetail = boundedDetail(detail);
    await this.mutate(state => {
      state.fallback = {
        active: true,
        ...(safeReason ? { reason: safeReason } : {}),
        ...(safeDetail ? { detail: safeDetail } : {}),
        activatedAt: this.now().toISOString()
      };
    });
  }

  async resetFallback(): Promise<ExecutionPolicyStatus> {
    await this.mutate(state => {
      state.fallback = { active: false };
      state.sessionFallbacks = {};
    });
    return await this.status();
  }
}

export function isCodexLimitSignal(value: string | undefined): boolean {
  const text = value?.toLowerCase() ?? '';
  if (!text) return false;
  return /\b429\b|rate[ -]?limit|usage[ -]?limit|quota|limit reached|reached (?:your|the) .*limit|too many requests|usage cap/.test(text);
}
