import type { ExecutionPolicyStatus } from './execution-policy.js';
import {
  executionTargetsForMode,
  type ExecutionTargetId,
  type ExecutionTargetMode,
  type SetupSettings,
  type WorkerRoutingProfile
} from './setup/settings.js';
import type { WorkerProviderStatus } from './worker-provider.js';

export const WORKER_ROUTING_INTENTS = [
  'general',
  'read',
  'workstation',
  'coding',
  'frontend-ui',
  'review',
  'debug'
] as const;

export type WorkerRoutingIntent = typeof WORKER_ROUTING_INTENTS[number];
export type WorkerRouteTarget = ExecutionTargetId | 'stop';

export interface WorkerRouteCandidate {
  target: WorkerRouteTarget;
  ready: boolean;
  reason: string;
}

export interface WorkerRoutePlan {
  profile: WorkerRoutingProfile;
  ownerTargetMode: ExecutionTargetMode;
  targetMode: ExecutionTargetMode;
  intent: WorkerRoutingIntent;
  selected: WorkerRouteTarget;
  canDispatchWorker: boolean;
  affinityOrder: ExecutionTargetId[];
  fallbackChain: WorkerRouteTarget[];
  candidates: WorkerRouteCandidate[];
  effectiveMode: ExecutionPolicyStatus['effectiveMode'];
  source: ExecutionPolicyStatus['source'];
  advisory: true;
  note: string;
}

function providerReady(providers: WorkerProviderStatus[], id: 'codex-local' | 'antigravity-local'): boolean {
  const status = providers.find(item => item.provider.id === id);
  return Boolean(status && status.availability === 'available' && status.dispatchCapable);
}

function codexBudgetAvailable(status: ExecutionPolicyStatus): boolean {
  if (status.maxCodexTasksPerDay > 0 && status.codexTasksToday >= status.maxCodexTasksPerDay) return false;
  if (status.maxCodexTasksPerSession > 0 && status.codexTasksThisSession >= status.maxCodexTasksPerSession) return false;
  return true;
}

export function affinityOrderForIntent(intent: WorkerRoutingIntent): ExecutionTargetId[] {
  if (intent === 'frontend-ui') return ['antigravity-local', 'codex-local', 'rwmcp-direct'];
  if (intent === 'coding' || intent === 'review' || intent === 'debug') {
    return ['codex-local', 'antigravity-local', 'rwmcp-direct'];
  }
  return ['rwmcp-direct', 'codex-local', 'antigravity-local'];
}

function policyAllowsTarget(status: ExecutionPolicyStatus, target: ExecutionTargetId): boolean {
  if (status.fallbackActive) return target === 'rwmcp-direct';
  if (status.effectiveMode === 'rwmcp-only') return target === 'rwmcp-direct';
  if (status.effectiveMode === 'codex-only') return target === 'codex-local';
  return true;
}

export function allowedExecutionTargets(
  settings: SetupSettings['execution'],
  status: ExecutionPolicyStatus
): ExecutionTargetId[] {
  return executionTargetsForMode(status.sessionTargetMode ?? settings.targetMode).filter(target => policyAllowsTarget(status, target));
}

export function planWorkerRoute(input: {
  settings: SetupSettings['execution'];
  status: ExecutionPolicyStatus;
  providers: WorkerProviderStatus[];
  intent: WorkerRoutingIntent;
}): WorkerRoutePlan {
  const { settings, status, providers, intent } = input;
  const profile = settings.workerRoutingProfile;
  const ownerTargetMode = settings.targetMode;
  const targetMode = status.sessionTargetMode ?? ownerTargetMode;
  const affinityOrder = affinityOrderForIntent(intent);
  const allowed = new Set(allowedExecutionTargets(settings, status));
  const desired = affinityOrder.filter(target => allowed.has(target));
  const fallbackChain: WorkerRouteTarget[] = desired.length > 0 ? desired : ['stop'];

  const codexReady = settings.codexEnabled && allowed.has('codex-local') &&
    codexBudgetAvailable(status) && providerReady(providers, 'codex-local');
  const antigravityReady = settings.antigravityEnabled && allowed.has('antigravity-local') &&
    providerReady(providers, 'antigravity-local');

  const candidates: WorkerRouteCandidate[] = fallbackChain.map(target => {
    if (target === 'rwmcp-direct') {
      return {
        target,
        ready: true,
        reason: 'Direct RWMCP is an allowed peer execution target under the authenticated workstation policy.'
      };
    }
    if (target === 'stop') {
      return { target, ready: true, reason: 'No execution target remains allowed by both owner target-set policy and the Work Session safety ceiling.' };
    }
    if (target === 'codex-local') {
      const reason = !settings.codexEnabled
        ? 'Codex is disabled by the local owner.'
        : !allowed.has('codex-local')
          ? 'Codex is excluded by the target set or effective Work Session safety ceiling.'
          : !codexBudgetAvailable(status)
            ? 'The configured Codex task budget is exhausted.'
            : providerReady(providers, 'codex-local')
              ? 'Codex is ready for bounded Work Session dispatch.'
              : 'Codex is unavailable or not dispatch-capable.';
      return { target, ready: codexReady, reason };
    }
    const reason = !settings.antigravityEnabled
      ? 'Antigravity is disabled by the local owner.'
      : !allowed.has('antigravity-local')
        ? 'Antigravity is excluded by the target set or effective Work Session safety ceiling.'
        : providerReady(providers, 'antigravity-local')
          ? 'Antigravity is ready for sandboxed Work Session dispatch.'
          : 'Antigravity is unavailable or not dispatch-capable.';
    return { target, ready: antigravityReady, reason };
  });

  const selectedCandidate = candidates.find(candidate => candidate.ready) ??
    { target: 'stop' as const, ready: true, reason: 'No configured route is currently usable.' };
  const selected = selectedCandidate.target;

  return {
    profile,
    ownerTargetMode,
    targetMode,
    intent,
    selected,
    canDispatchWorker: selected === 'codex-local' || selected === 'antigravity-local',
    affinityOrder,
    fallbackChain,
    candidates,
    effectiveMode: status.effectiveMode,
    source: status.source,
    advisory: true,
    note: selected === 'antigravity-local'
      ? 'Antigravity is preferred by this task affinity, not by a hard capability lock. Other allowed targets remain valid fallbacks without widening permissions.'
      : selected === 'codex-local'
        ? 'Codex is preferred by this task affinity, not by a hard capability lock. Other allowed targets remain valid fallbacks while ChatGPT retains planning and acceptance authority.'
        : selected === 'rwmcp-direct'
          ? 'RWMCP direct is the preferred deterministic peer target for this affinity; AI workers remain alternates when the owner target set allows them.'
          : 'Stop and surface the owner/session policy blocker instead of dispatching an unapproved target.'
  };
}
