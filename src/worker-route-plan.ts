import type { ExecutionPolicyStatus } from './execution-policy.js';
import type { SetupSettings, WorkerRoutingProfile } from './setup/settings.js';
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
export type WorkerRouteTarget = 'rwmcp-direct' | 'codex-local' | 'antigravity-local' | 'stop';

export interface WorkerRouteCandidate {
  target: WorkerRouteTarget;
  ready: boolean;
  reason: string;
}

export interface WorkerRoutePlan {
  profile: WorkerRoutingProfile;
  intent: WorkerRoutingIntent;
  selected: WorkerRouteTarget;
  canDispatchWorker: boolean;
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

function uniqueTargets(values: WorkerRouteTarget[]): WorkerRouteTarget[] {
  return [...new Set(values)];
}

function codexBudgetAvailable(status: ExecutionPolicyStatus): boolean {
  if (status.maxCodexTasksPerDay > 0 && status.codexTasksToday >= status.maxCodexTasksPerDay) return false;
  if (status.maxCodexTasksPerSession > 0 && status.codexTasksThisSession >= status.maxCodexTasksPerSession) return false;
  return true;
}

export function planWorkerRoute(input: {
  settings: SetupSettings['execution'];
  status: ExecutionPolicyStatus;
  providers: WorkerProviderStatus[];
  intent: WorkerRoutingIntent;
}): WorkerRoutePlan {
  const { settings, status, providers, intent } = input;
  const profile = settings.workerRoutingProfile;
  const directIntent = intent === 'read' || intent === 'workstation';
  const codexAllowed = status.effectiveMode !== 'rwmcp-only';
  const antigravityAllowed = status.effectiveMode === 'both';
  const codexReady = settings.codexEnabled && codexAllowed && !status.fallbackActive &&
    codexBudgetAvailable(status) && providerReady(providers, 'codex-local');
  const antigravityReady = settings.antigravityEnabled && antigravityAllowed &&
    providerReady(providers, 'antigravity-local');
  const fallback = settings.codexFallback === 'rwmcp-only' ? 'rwmcp-direct' as const : 'stop' as const;

  let desired: WorkerRouteTarget[];
  if (directIntent || profile === 'direct') {
    desired = ['rwmcp-direct'];
  } else if (profile === 'codex-assisted') {
    desired = ['codex-local', fallback];
  } else if (profile === 'smart') {
    desired = intent === 'frontend-ui'
      ? ['antigravity-local', 'codex-local', fallback]
      : ['codex-local', fallback];
  } else if (status.effectiveMode === 'rwmcp-only') {
    desired = ['rwmcp-direct'];
  } else if (status.effectiveMode === 'codex-only') {
    desired = ['codex-local', fallback];
  } else if (intent === 'frontend-ui' && settings.antigravityEnabled) {
    desired = ['antigravity-local', 'codex-local', fallback];
  } else {
    desired = ['codex-local', fallback];
  }

  const fallbackChain = uniqueTargets(desired);
  const candidates: WorkerRouteCandidate[] = fallbackChain.map(target => {
    if (target === 'rwmcp-direct') {
      return { target, ready: true, reason: 'Direct RWMCP is available under the authenticated workstation policy.' };
    }
    if (target === 'stop') {
      return { target, ready: true, reason: 'Owner policy requires stopping instead of direct RWMCP fallback.' };
    }
    if (target === 'codex-local') {
      const reason = !settings.codexEnabled
        ? 'Codex is disabled by the local owner.'
        : !codexAllowed
          ? 'The effective Work Session execution mode blocks Codex dispatch.'
          : status.fallbackActive
            ? 'Codex dispatch is blocked by the active fallback latch.'
            : !codexBudgetAvailable(status)
              ? 'The configured Codex task budget is exhausted.'
              : providerReady(providers, 'codex-local')
                ? 'Codex is ready for bounded Work Session dispatch.'
                : 'Codex is unavailable or not dispatch-capable.';
      return { target, ready: codexReady, reason };
    }
    const reason = !settings.antigravityEnabled
      ? 'Antigravity is disabled by the local owner.'
      : !antigravityAllowed
        ? 'The effective Work Session execution mode does not allow the Antigravity route.'
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
    intent,
    selected,
    canDispatchWorker: selected === 'codex-local' || selected === 'antigravity-local',
    fallbackChain,
    candidates,
    effectiveMode: status.effectiveMode,
    source: status.source,
    advisory: true,
    note: selected === 'antigravity-local'
      ? 'Antigravity is selected only as the frontend/UI specialist. Sandbox or privilege blockers must fall through to the next ready route; permissions are never widened automatically.'
      : selected === 'codex-local'
        ? 'Codex is selected for bounded implementation/review while ChatGPT retains planning and acceptance authority.'
        : selected === 'rwmcp-direct'
          ? 'Use RWMCP directly; no worker provider should be dispatched for this task.'
          : 'Stop and surface the owner-policy blocker instead of dispatching a worker.'
  };
}
