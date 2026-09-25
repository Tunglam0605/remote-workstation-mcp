import fs from 'node:fs/promises';
import path from 'node:path';
import { executionTargetModePreset, isExecutionTargetMode, loadSetupSettings, setupConfigDir, type ExecutionMode, type ExecutionTargetId, type ExecutionTargetMode, type SetupSettings } from './setup/settings.js';

export type ExecutionPolicySource = 'owner-default' | 'work-session-override' | 'fallback-latch';

interface SessionOverride {
  mode?: ExecutionMode;
  targetMode?: ExecutionTargetMode;
  setAt: string;
}

interface ExecutionPolicyStateV1 {
  version: 1;
  fallback?: { active: boolean; reason?: string; detail?: string; activatedAt?: string };
  daily?: { date: string; codexTasks: number };
  sessionCodexTasks?: Record<string, number>;
  targetDaily?: Partial<Record<ExecutionTargetId, { date: string; tasks: number }>>;
  sessionTargetTasks?: Record<string, Partial<Record<ExecutionTargetId, number>>>;
  overrides?: Record<string, SessionOverride>;
  sessionFallbacks?: Record<string, { reason: string; detail?: string; activatedAt: string }>;
}

export interface ExecutionTargetRuntimePolicyStatus {
  enabledTargets: ExecutionTargetId[];
  fallback: 'rwmcp-direct' | 'stop';
  targets: Record<ExecutionTargetId, {
    enabled: boolean;
    tasksToday: number;
    tasksThisSession: number;
    maxTasksPerDay: number;
    maxTasksPerSession: number;
  }>;
}

export interface ExecutionPolicyStatus {
  configuredMode: ExecutionMode;
  effectiveMode: ExecutionMode;
  source: ExecutionPolicySource;
  targetPolicy: ExecutionTargetRuntimePolicyStatus;
  codexEnabled: boolean;
  allowChatOverride: boolean;
  codexFallback: 'rwmcp-only' | 'stop';
  fallbackActive: boolean;
  fallbackReason?: string;
  fallbackDetail?: string;
  fallbackActivatedAt?: string;
  workSessionId?: string;
  sessionOverride?: ExecutionMode;
  sessionTargetMode?: ExecutionTargetMode;
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
    return { version: 1, fallback: { active: false }, sessionCodexTasks: {}, targetDaily: {}, sessionTargetTasks: {}, overrides: {}, sessionFallbacks: {} };
  }

  private async load(): Promise<ExecutionPolicyStateV1> {
    try {
      const raw = JSON.parse((await fs.readFile(this.file, 'utf8')).replace(/^\uFEFF/, '')) as Partial<ExecutionPolicyStateV1>;
      if (raw.version !== 1) throw new Error('Invalid execution policy state version.');

      const overrides: Record<string, SessionOverride> = {};
      for (const [sessionId, entry] of Object.entries(raw.overrides ?? {})) {
        if (!entry || typeof entry.setAt !== 'string') continue;
        const mode = validMode(entry.mode) ? entry.mode : undefined;
        const targetMode = isExecutionTargetMode(entry.targetMode) ? entry.targetMode : undefined;
        if (!mode && !targetMode) continue;
        overrides[sessionId] = { ...(mode ? { mode } : {}), ...(targetMode ? { targetMode } : {}), setAt: entry.setAt };
      }

      const sessionCodexTasks: Record<string, number> = {};
      for (const [sessionId, count] of Object.entries(raw.sessionCodexTasks ?? {})) {
        if (Number.isSafeInteger(count) && count >= 0) sessionCodexTasks[sessionId] = count;
      }

      const targetDaily: Partial<Record<ExecutionTargetId, { date: string; tasks: number }>> = {};
      for (const target of ['rwmcp-direct', 'codex-local', 'antigravity-local'] as const) {
        const entry = raw.targetDaily?.[target];
        if (entry && typeof entry.date === 'string' && Number.isSafeInteger(entry.tasks) && entry.tasks >= 0) {
          targetDaily[target] = { date: entry.date, tasks: entry.tasks };
        }
      }
      if (!targetDaily['codex-local'] && raw.daily && typeof raw.daily.date === 'string' && Number.isSafeInteger(raw.daily.codexTasks) && raw.daily.codexTasks >= 0) {
        targetDaily['codex-local'] = { date: raw.daily.date, tasks: raw.daily.codexTasks };
      }

      const sessionTargetTasks: Record<string, Partial<Record<ExecutionTargetId, number>>> = {};
      for (const [sessionId, counts] of Object.entries(raw.sessionTargetTasks ?? {})) {
        if (!counts || typeof counts !== 'object') continue;
        const clean: Partial<Record<ExecutionTargetId, number>> = {};
        for (const target of ['rwmcp-direct', 'codex-local', 'antigravity-local'] as const) {
          const count = counts[target];
          if (Number.isSafeInteger(count) && Number(count) >= 0) clean[target] = Number(count);
        }
        if (Object.keys(clean).length) sessionTargetTasks[sessionId] = clean;
      }
      for (const [sessionId, count] of Object.entries(sessionCodexTasks)) {
        sessionTargetTasks[sessionId] ??= {};
        if (sessionTargetTasks[sessionId]!['codex-local'] === undefined) sessionTargetTasks[sessionId]!['codex-local'] = count;
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
        targetDaily,
        sessionTargetTasks,
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
    const targetSessionEntries = Object.entries(state.sessionTargetTasks ?? {});
    if (targetSessionEntries.length > 256) state.sessionTargetTasks = Object.fromEntries(targetSessionEntries.slice(-256));
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

  private targetTasksToday(state: ExecutionPolicyStateV1, target: ExecutionTargetId): number {
    const entry = state.targetDaily?.[target];
    return entry?.date === this.today() ? entry.tasks : 0;
  }

  private targetTasksThisSession(state: ExecutionPolicyStateV1, workSessionId: string | undefined, target: ExecutionTargetId): number {
    return workSessionId ? (state.sessionTargetTasks?.[workSessionId]?.[target] ?? 0) : 0;
  }

  async status(workSessionId?: string): Promise<ExecutionPolicyStatus> {
    const [settings, state] = await Promise.all([this.loadSettings(), this.load()]);
    const configuredMode = settings.execution.defaultMode;
    const sessionEntry = workSessionId ? state.overrides?.[workSessionId] : undefined;
    const sessionOverride = sessionEntry?.mode;
    const sessionTargetMode = sessionEntry?.targetMode;
    const globalFallbackActive = state.fallback?.active === true && settings.execution.targetPolicy.fallback === 'rwmcp-direct';
    const sessionFallback = workSessionId && settings.execution.targetPolicy.fallback === 'rwmcp-direct'
      ? state.sessionFallbacks?.[workSessionId]
      : undefined;
    const fallbackActive = globalFallbackActive || Boolean(sessionFallback);

    let effectiveMode: ExecutionMode = configuredMode;
    let source: ExecutionPolicySource = 'owner-default';

    if (settings.execution.allowChatOverride && sessionOverride) {
      effectiveMode = sessionOverride;
      source = 'work-session-override';
    }
    if (settings.execution.allowChatOverride && sessionTargetMode) {
      effectiveMode = executionTargetModePreset(sessionTargetMode).defaultMode;
      source = 'work-session-override';
    }
    if (fallbackActive) {
      effectiveMode = 'rwmcp-only';
      source = 'fallback-latch';
    }
    if (!settings.execution.codexEnabled && effectiveMode === 'codex-only') {
      effectiveMode = 'rwmcp-only';
      source = 'owner-default';
    }

    const targetRuntime = Object.fromEntries((['rwmcp-direct', 'codex-local', 'antigravity-local'] as const).map(target => {
      const budget = settings.execution.targetPolicy.budgets[target];
      return [target, {
        enabled: settings.execution.targetPolicy.enabledTargets.includes(target),
        tasksToday: this.targetTasksToday(state, target),
        tasksThisSession: this.targetTasksThisSession(state, workSessionId, target),
        maxTasksPerDay: budget.maxTasksPerDay,
        maxTasksPerSession: budget.maxTasksPerSession
      }];
    })) as ExecutionTargetRuntimePolicyStatus['targets'];
    const targetPolicy: ExecutionTargetRuntimePolicyStatus = {
      enabledTargets: [...settings.execution.targetPolicy.enabledTargets],
      fallback: settings.execution.targetPolicy.fallback,
      targets: targetRuntime
    };
    const codexTasksToday = targetRuntime['codex-local'].tasksToday;
    return {
      configuredMode,
      effectiveMode,
      source,
      targetPolicy,
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
      ...(sessionTargetMode ? { sessionTargetMode } : {}),
      codexTasksToday,
      codexTasksThisSession: targetRuntime['codex-local'].tasksThisSession,
      maxCodexTasksPerDay: targetRuntime['codex-local'].maxTasksPerDay,
      maxCodexTasksPerSession: targetRuntime['codex-local'].maxTasksPerSession,
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

  async setSessionTargetModeOverride(workSessionId: string, targetMode: ExecutionTargetMode | null): Promise<ExecutionPolicyStatus> {
    const settings = await this.loadSettings();
    if (!settings.execution.allowChatOverride) {
      throw new Error('EXECUTION_POLICY_CHAT_OVERRIDE_DISABLED: owner disabled chat/session execution overrides in Control Center.');
    }
    await this.mutate(state => {
      state.overrides ??= {};
      if (targetMode === null) delete state.overrides[workSessionId];
      else state.overrides[workSessionId] = { targetMode, setAt: this.now().toISOString() };
    });
    return await this.status(workSessionId);
  }

  async clearSessionOverrides(): Promise<ExecutionPolicyStatus> {
    await this.mutate(state => { state.overrides = {}; });
    return await this.status();
  }

  async beforeTargetDispatch(
    target: Exclude<ExecutionTargetId, 'rwmcp-direct'>,
    workSessionId: string,
    options: { deferFallback?: boolean } = {}
  ): Promise<ExecutionPolicyStatus> {
    const status = await this.status(workSessionId);
    const runtime = status.targetPolicy.targets[target];
    if (!runtime.enabled || status.fallbackActive || status.effectiveMode === 'rwmcp-only') {
      throw new Error(`EXECUTION_POLICY_TARGET_DISABLED: ${target} is disabled by the effective target policy.`);
    }
    if (status.effectiveMode === 'codex-only' && target !== 'codex-local') {
      throw new Error(`EXECUTION_POLICY_TARGET_DISABLED: ${target} is excluded by the legacy Work Session safety ceiling.`);
    }
    const label = target === 'codex-local' ? 'Codex' : 'Antigravity';
    if (runtime.maxTasksPerSession > 0 && runtime.tasksThisSession >= runtime.maxTasksPerSession) {
      if (options.deferFallback === true) {
        throw new Error(`TARGET_BUDGET_REACHED: ${target} Work Session task budget reached; alternate routing may continue.`);
      }
      await this.activateSessionFallback(workSessionId, 'session-budget', `${label} task budget for this Work Session was reached.`);
      const after = await this.status(workSessionId);
      throw new Error(after.fallbackActive
        ? `TARGET_FALLBACK_ACTIVE: ${target} Work Session budget reached; effective route switched to rwmcp-direct.`
        : `TARGET_BUDGET_REACHED: ${target} Work Session budget reached; fallback policy is stop.`);
    }
    if (runtime.maxTasksPerDay > 0 && runtime.tasksToday >= runtime.maxTasksPerDay) {
      if (options.deferFallback === true) {
        throw new Error(`TARGET_BUDGET_REACHED: ${target} daily task budget reached; alternate routing may continue.`);
      }
      await this.activateFallback('daily-budget', `Daily ${label} task budget was reached.`);
      const after = await this.status(workSessionId);
      throw new Error(after.fallbackActive
        ? `TARGET_FALLBACK_ACTIVE: ${target} daily budget reached; effective route switched to rwmcp-direct.`
        : `TARGET_BUDGET_REACHED: ${target} daily budget reached; fallback policy is stop.`);
    }

    await this.mutate(state => {
      const date = this.today();
      state.targetDaily ??= {};
      const currentDaily = state.targetDaily[target];
      if (!currentDaily || currentDaily.date !== date) state.targetDaily[target] = { date, tasks: 0 };
      state.targetDaily[target]!.tasks += 1;
      state.sessionTargetTasks ??= {};
      state.sessionTargetTasks[workSessionId] ??= {};
      state.sessionTargetTasks[workSessionId]![target] = (state.sessionTargetTasks[workSessionId]![target] ?? 0) + 1;

      // v0.41 rollback compatibility: keep legacy Codex counters in sync.
      if (target === 'codex-local') {
        const daily = this.normalizeDaily(state);
        daily.codexTasks += 1;
        state.sessionCodexTasks ??= {};
        state.sessionCodexTasks[workSessionId] = (state.sessionCodexTasks[workSessionId] ?? 0) + 1;
      }
    });
    return await this.status(workSessionId);
  }

  async beforeCodexDispatch(
    workSessionId: string,
    options: { deferFallback?: boolean } = {}
  ): Promise<ExecutionPolicyStatus> {
    try {
      return await this.beforeTargetDispatch('codex-local', workSessionId, options);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (text.startsWith('TARGET_BUDGET_REACHED:')) throw new Error(text.replace('TARGET_BUDGET_REACHED:', 'CODEX_BUDGET_REACHED:'));
      if (text.startsWith('TARGET_FALLBACK_ACTIVE:')) throw new Error(text.replace('TARGET_FALLBACK_ACTIVE:', 'CODEX_FALLBACK_ACTIVE:'));
      throw error;
    }
  }

  async activateSessionFallback(workSessionId: string, reason: string, detail?: string): Promise<void> {
    const settings = await this.loadSettings();
    if (settings.execution.targetPolicy.fallback !== 'rwmcp-direct') return;
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
    if (settings.execution.targetPolicy.fallback !== 'rwmcp-direct') return;
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

export function isWorkerCapacitySignal(value: string | undefined): boolean {
  const text = value?.toLowerCase() ?? '';
  if (!text) return false;
  if (/antigravity_permission_required|sandbox_attestation_failed|shared_skills_invalid|eas_config_invalid/.test(text)) {
    return false;
  }
  return /\b429\b|rate[ -]?limit|usage[ -]?limit|quota|limit reached|reached (?:your|the) .*limit|too many requests|usage cap|out of credits|resource[ -]?exhausted/.test(text) ||
    /codex_(?:limit_reached|budget_reached|auth_required|account_pool_unavailable)/.test(text) ||
    /target_(?:budget_reached|fallback_active)/.test(text) ||
    /antigravity_(?:limit_reached|auth_required)/.test(text) ||
    /worker provider .+ is not available/.test(text) ||
    /(?:codex|antigravity).+(?:authentication unavailable|not authenticated|sign[ -]?in required)/.test(text);
}

export function isCodexLimitSignal(value: string | undefined): boolean {
  return isWorkerCapacitySignal(value);
}
