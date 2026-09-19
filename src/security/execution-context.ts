import { AsyncLocalStorage } from 'node:async_hooks';
import {
  IMPLICIT_WORK_SESSION_ID,
  type ResourceOwner
} from '../work-session.js';

export type ResourceOwnerSource =
  | string
  | ResourceOwner
  | (() => string | ResourceOwner);

interface WorkSessionExecutionContext {
  workSessionId: string;
  explicit: boolean;
}

const storage = new AsyncLocalStorage<WorkSessionExecutionContext>();

function normalizePrincipalId(value: string): string {
  const trimmed = value.trim();
  return trimmed || 'unknown';
}

export function resourceOwnerKey(principalId: string, workSessionId: string): string {
  return JSON.stringify([normalizePrincipalId(principalId), workSessionId || IMPLICIT_WORK_SESSION_ID]);
}

export function resolveResourceOwner(source: ResourceOwnerSource = 'unknown'): ResourceOwner {
  const raw = typeof source === 'function' ? source() : source;
  if (typeof raw !== 'string') return raw;

  const principalId = normalizePrincipalId(raw);
  const execution = storage.getStore();
  const workSessionId = execution?.workSessionId || IMPLICIT_WORK_SESSION_ID;
  return {
    principalId,
    workSessionId,
    implicit: !execution?.explicit,
    key: resourceOwnerKey(principalId, workSessionId)
  };
}

export function currentWorkSessionId(): string {
  return storage.getStore()?.workSessionId ?? IMPLICIT_WORK_SESSION_ID;
}

export function runWithWorkSession<T>(
  workSessionId: string | undefined,
  operation: () => T
): T {
  const normalized = workSessionId?.trim() || IMPLICIT_WORK_SESSION_ID;
  return storage.run(
    { workSessionId: normalized, explicit: normalized !== IMPLICIT_WORK_SESSION_ID },
    operation
  );
}
