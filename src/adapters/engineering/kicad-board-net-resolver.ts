/**
 * Resolve both numbered and named-only KiCad board net references.
 * KiCad 10 pcbnew may serialize copper as (net "/NAME") instead of (net 12).
 * Synthetic negative IDs are analysis-only; they are never persisted to PCB files.
 */
export interface BoardNetResolver {
  readonly names: Map<number, string>;
  resolveId(block: string): number | undefined;
}

function unescapeName(value: string): string {
  return value.replace(/\\(["\\])/g, '$1');
}

export function createBoardNetResolver(source: string): BoardNetResolver {
  const names = new Map<number, string>();
  const idsByName = new Map<string, number>();
  for (const match of source.matchAll(/\(net\s+(\d+)\s+"((?:\\.|[^"\\])*)"\s*\)/g)) {
    const id = Number(match[1]);
    if (!Number.isSafeInteger(id) || id < 0 || match[2] === undefined) continue;
    const name = unescapeName(match[2]);
    if (!names.has(id)) names.set(id, name);
    if (!idsByName.has(name)) idsByName.set(name, id);
  }
  let syntheticId = -1;
  return {
    names,
    resolveId(block: string): number | undefined {
      const token = block.match(/\(net\s+(?:(\d+)(?:\s+"((?:\\.|[^"\\])*)")?|"((?:\\.|[^"\\])*)")\s*\)/);
      if (!token) return undefined;
      if (token[1] !== undefined) {
        const id = Number(token[1]);
        if (!Number.isSafeInteger(id) || id < 0) return undefined;
        if (token[2] !== undefined && !names.has(id)) {
          const name = unescapeName(token[2]);
          names.set(id, name);
          if (!idsByName.has(name)) idsByName.set(name, id);
        }
        return id;
      }
      const name = unescapeName(token[3] ?? '');
      const existing = idsByName.get(name);
      if (existing !== undefined) return existing;
      const id = syntheticId--;
      names.set(id, name);
      idsByName.set(name, id);
      return id;
    }
  };
}
