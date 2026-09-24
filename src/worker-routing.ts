import type { ExecutionPolicyStatus } from './execution-policy.js';
import type { SetupSettings, WorkerRoutingProfile } from './setup/settings.js';
import type { WorkerProviderStatus } from './worker-provider.js';

export const WORKER_ROUTING_INTENTS = [
  'general',
  'coding',
  'frontend-ui',
  'review',
  'research',
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
  note: string;
}

function providerReady(providers: WorkerProviderStatus[], id: 'codex-local' | 'antigravity-local'): boolean {
  const status = providers.find(item => item.provider.id === id);
  return Boolean(status && status.availability === 'available' && status.dispatchCapable);
}

function candidate(target: WorkerRouteTarget, ready: boolean, reason: string): WorkerRouteCandidate {
  return { target, ready, reason };
}

function uniqueTargets(values: WorkerRouteTarget[]): WorkerRouteTarget[] {
  return [...new Set(values)];
}

export function planWorkerRoute(input: {
  settings: SetupSettings['execution'];
  status: ExecutionPolicyStatus;
  providers: WorkerProviderStatus[];
  intent: WorkerRoutingIntent;
}): WorkerRoutePlan {
  const { settings, status, providers, intent } = input;
  const profile = settings.workerRoutingProfile;
  const codexReady = settings.codexEnabled && status.effectiveMode !== 'rwmcp-only' && providerReady(providers, 'codex-local');
  const antigravityReady = settings.antigravityEnabled && providerReady(providers, 'antigravity-local');
  const candidates: WorkerRouteCandidate[] = [];

  let desired: WorkerRouteTarget[];
  if (profile === 'direct') {
    desired = ['rwmcp-direct'];
  } else if (profile === 'codex-assisted') {
    desired = ['codex-local', settings.codexFallback === 'rwmcp-only' ? 'rwmcp-direct' : 'stop'];
  } else if (profile === 'smart') {
    desired = intent === 'frontend-ui'
      ? ['antigravity-local', 'codex-local', settings.codexFallback === 'rwmcp-only' ? 'rwmcp-direct' : 'stop']
      : ['codex-local', settings.codexFallback === 'rwmcp-only' ? 'rwmcp-direct' : 'stop'];
  } else {
    if (status.effectiveMode === 'rwmcp-only') {
      desired = ['rwmcp-direct'];
    } else if (intent === 'frontend-ui' && settings.antigravityEnabled) {
      desired = ['antigravity-local', 'codex-local', settings.codexFallback === 'rwmcp-only' ? 'rwmcp-direct' : 'stop'];
    } else {
      desired = ['codex-local', settings.codexFallback === 'rwmcp-only' ? 'rwmcp-direct' : 'stop'];
    }
  }

  const fallbackChain = uniqueTargets(desired);
  for (const target of fallbackChain) {
    if (target === 'rwmcp-direct') {
      candidates.push(candidate(target, true, 'Direct RWMCP remains available under the authenticated local policy.'));
    } else if (target === 'stop') {
      candidates.push(candidate(target, true, 'Owner policy requires stopping instead of falling back to RWMCP.'));
    } else if (target === 'codex-local') {
      candidates.push(candidate(
        target,
        codexReady,
        !settings.codexEnabled
          ? 'Codex is disabled by the local owner.'
          : status.effectiveMode === 'rwmcp-only'
            ? 'The effective execution mode currently blocks Codex dispatch.'
            : providerReady(providers, 'codex-local')
              ? 'Codex is ready for bounded Work Session dispatch.'
              : 'Codex provider is unavailable or not dispatch-capable.'
      ));
    } else {
      candidates.push(candidate(
        target,
        antigravityReady,
        !settings.antigravityEnabled
          ? 'Antigravity is disabled by the local owner.'
          : providerReady(providers, 'antigravity-local')
            ? 'Antigravity is ready for sandboxed Work Session dispatch. Privileged permission prompts still fail closed.'
            : 'Antigravity provider is unavailable or not dispatch-capable.'
      ));
    }
  }

  const selectedCandidate = candidates.find(item => item.ready) ?? candidate('stop', true, 'No configured route is currently usable.');
  const selected = selectedCandidate.target;
  const canDispatchWorker = selected === 'codex-local' || selected === 'antigravity-local';

  return {
    profile,
    intent,
    selected,
    canDispatchWorker,
    fallbackChain,
    candidates,
    effectiveMode: status.effectiveMode,
    source: status.source,
    note: selected === 'antigravity-local'
      ? 'Antigravity is selected as the frontend/UI specialist. If it is blocked by sandbox permission policy, ChatGPT should retry with the next ready route rather than relaxing permissions automatically.'
      : selected === 'codex-local'
        ? 'Codex is selected as the general coding/review worker while ChatGPT retains planning and acceptance authority.'
        : selected === 'rwmcp-direct'
          ? 'Use RWMCP directly; no worker provider should be dispatched for this task.'
          : 'Stop and surface the owner-policy blocker instead of dispatching a worker.'
  };
}
