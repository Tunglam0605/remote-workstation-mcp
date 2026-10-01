export type JsonScalar = string | number | boolean | null;

export type JsonObservation = {
  path: string;
  matchedField: string;
  matchedValue: JsonScalar;
  selected: Record<string, JsonScalar>;
};

function scalar(value: unknown): JsonScalar | undefined {
  if (value === null) return null;
  if (typeof value === 'string') return value.slice(0, 512);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value;
  return undefined;
}

function sameScalar(left: JsonScalar, right: JsonScalar): boolean {
  return Object.is(left, right);
}

export function findJsonObservations(
  payload: unknown,
  options: {
    matchField: string;
    matchEquals?: JsonScalar;
    selectFields?: string[];
    maxDepth?: number;
    maxVisited?: number;
    maxMatches?: number;
  }
): JsonObservation[] {
  const matchField = options.matchField.trim();
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(matchField)) throw new Error('matchField must be a bounded JSON property name.');
  const selectFields = options.selectFields ?? [];
  if (selectFields.length > 32 || selectFields.some(field => !/^[A-Za-z0-9_.:-]{1,128}$/.test(field))) {
    throw new Error('selectFields must contain at most 32 bounded JSON property names.');
  }
  const maxDepth = options.maxDepth ?? 5;
  const maxVisited = options.maxVisited ?? 256;
  const maxMatches = options.maxMatches ?? 32;
  if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 8) throw new Error('maxDepth must be between 0 and 8.');
  if (!Number.isInteger(maxVisited) || maxVisited < 1 || maxVisited > 1024) throw new Error('maxVisited must be between 1 and 1024.');
  if (!Number.isInteger(maxMatches) || maxMatches < 1 || maxMatches > 128) throw new Error('maxMatches must be between 1 and 128.');

  const queue: Array<{ value: unknown; path: string; depth: number }> = [{ value: payload, path: '$', depth: 0 }];
  const seen = new Set<object>();
  const results: JsonObservation[] = [];
  let visited = 0;

  while (queue.length && visited < maxVisited && results.length < maxMatches) {
    const current = queue.shift()!;
    visited += 1;
    if (!current.value || typeof current.value !== 'object') continue;

    const object = current.value as Record<string, unknown>;
    if (seen.has(object)) continue;
    seen.add(object);

    if (!Array.isArray(object) && Object.prototype.hasOwnProperty.call(object, matchField)) {
      const matchedValue = scalar(object[matchField]);
      const equalsSatisfied = matchedValue !== undefined &&
        (options.matchEquals === undefined || sameScalar(matchedValue, options.matchEquals));
      if (equalsSatisfied) {
        const selected: Record<string, JsonScalar> = {};
        for (const field of selectFields) {
          const value = scalar(object[field]);
          if (value !== undefined) selected[field] = value;
        }
        results.push({
          path: current.path,
          matchedField: matchField,
          matchedValue,
          selected
        });
      }
    }

    if (current.depth >= maxDepth) continue;
    const entries = Array.isArray(object)
      ? object.slice(0, 64).map((value, index) => [String(index), value] as const)
      : Object.entries(object).slice(0, 64);
    for (const [key, value] of entries) {
      if (value && typeof value === 'object') {
        queue.push({
          value,
          path: Array.isArray(object) ? `${current.path}[${key}]` : `${current.path}.${key}`,
          depth: current.depth + 1
        });
      }
    }
  }

  return results;
}
