export type LiftPosition = 'up' | 'down' | 'between' | 'conflict' | 'unknown';

export interface LiftSensorStatus {
  head?: boolean;
  tail?: boolean;
  up?: boolean;
  down?: boolean;
  state?: string;
  position: LiftPosition;
  path: string;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function boundedState(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().replace(/\s+/g, ' ').slice(0, 128);
  return normalized || undefined;
}

export function inferLiftPosition(up: boolean | undefined, down: boolean | undefined): LiftPosition {
  if (up === true && down === true) return 'conflict';
  if (up === true && down !== true) return 'up';
  if (down === true && up !== true) return 'down';
  if (up === false && down === false) return 'between';
  return 'unknown';
}

export function findLiftSensorStatus(
  payload: unknown,
  options: { maxDepth?: number; maxVisited?: number } = {}
): LiftSensorStatus | undefined {
  const maxDepth = options.maxDepth ?? 5;
  const maxVisited = options.maxVisited ?? 256;
  if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 8) throw new Error('maxDepth must be between 0 and 8.');
  if (!Number.isInteger(maxVisited) || maxVisited < 1 || maxVisited > 1024) throw new Error('maxVisited must be between 1 and 1024.');

  const queue: Array<{ value: unknown; path: string; depth: number }> = [{ value: payload, path: '$', depth: 0 }];
  const seen = new Set<object>();
  let visited = 0;

  while (queue.length && visited < maxVisited) {
    const current = queue.shift()!;
    visited += 1;
    if (!current.value || typeof current.value !== 'object') continue;

    const object = current.value as Record<string, unknown>;
    if (seen.has(object)) continue;
    seen.add(object);

    const infoType = typeof object.infoType === 'string' ? object.infoType.trim() : undefined;
    if (infoType === 'liftSensorStatus') {
      const up = bool(object.up);
      const down = bool(object.down);
      return {
        ...(bool(object.head) !== undefined ? { head: bool(object.head) } : {}),
        ...(bool(object.tail) !== undefined ? { tail: bool(object.tail) } : {}),
        ...(up !== undefined ? { up } : {}),
        ...(down !== undefined ? { down } : {}),
        ...(boundedState(object.state) ? { state: boundedState(object.state) } : {}),
        position: inferLiftPosition(up, down),
        path: current.path
      };
    }

    if (current.depth >= maxDepth) continue;
    const entries = Array.isArray(object)
      ? object.slice(0, 64).map((value, index) => [String(index), value] as const)
      : Object.entries(object).slice(0, 64);
    for (const [key, value] of entries) {
      if (value && typeof value === 'object') {
        queue.push({ value, path: Array.isArray(object) ? current.path + '[' + key + ']' : current.path + '.' + key, depth: current.depth + 1 });
      }
    }
  }

  return undefined;
}
