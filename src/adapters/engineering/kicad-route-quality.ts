/**
 * Read-only geometric turn diagnostics for straight KiCad copper segments.
 * Not a router, not an ERC/DRC validator: junctions containing vias are excluded,
 * bends on arcs/pads are not modeled, and reported candidates require visual review.
 */
export type RoutingPoint = { x: number; y: number };
export interface RoutingSegmentEvidence {
  netId: number;
  netName: string;
  layer: string;
  start: RoutingPoint;
  end: RoutingPoint;
}
export interface RoutingViaEvidence {
  netId: number;
  layers: string[];
  at: RoutingPoint;
}
type Endpoint = { other: RoutingPoint; segmentId: number };
type NetTurnStats = { netName: string; rightAngleCount: number; diagonalTurnCount: number; reversalCount: number; branchNodeCount: number; eligibleJunctions: number };

function endpointKey(netId: number, layer: string, point: RoutingPoint): string {
  return netId + '|' + layer + '|' + point.x.toFixed(4) + '|' + point.y.toFixed(4);
}
function turnAngleDegrees(center: RoutingPoint, first: RoutingPoint, second: RoutingPoint): number | undefined {
  const ax = first.x - center.x, ay = first.y - center.y;
  const bx = second.x - center.x, by = second.y - center.y;
  const product = Math.hypot(ax, ay) * Math.hypot(bx, by);
  if (product <= 1e-12) return undefined;
  const angle = Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / product))) * 180 / Math.PI;
  return 180 - angle;
}

/** Candidate ranking is deterministic and evidence-only; do not automatically reroute. */
export function inspectRoutingTurns(segments: RoutingSegmentEvidence[], vias: RoutingViaEvidence[], maxDetails = 25) {
  const nodes = new Map<string, { netId: number; netName: string; layer: string; point: RoutingPoint; ends: Endpoint[] }>();
  const excluded = new Set<string>();
  const summaries = new Map<number, NetTurnStats>();
  const get = (netId: number, netName: string): NetTurnStats => {
    let row = summaries.get(netId);
    if (!row) {
      row = { netName, rightAngleCount: 0, diagonalTurnCount: 0, reversalCount: 0, branchNodeCount: 0, eligibleJunctions: 0 };
      summaries.set(netId, row);
    }
    return row;
  };
  for (const via of vias) for (const layer of via.layers) excluded.add(endpointKey(via.netId, layer, via.at));
  for (const [segmentId, segment] of segments.entries()) {
    get(segment.netId, segment.netName);
    for (const [point, other] of [[segment.start, segment.end], [segment.end, segment.start]] as const) {
      const key = endpointKey(segment.netId, segment.layer, point);
      let node = nodes.get(key);
      if (!node) {
        node = { netId: segment.netId, netName: segment.netName, layer: segment.layer, point, ends: [] };
        nodes.set(key, node);
      }
      node.ends.push({ other, segmentId });
    }
  }
  let rightAngleCount = 0, diagonalTurnCount = 0, reversalCount = 0, branchNodeCount = 0, eligibleJunctions = 0, excludedViaJunctions = 0;
  for (const [key, node] of nodes) {
    const stat = get(node.netId, node.netName);
    if (excluded.has(key)) { excludedViaJunctions++; continue; }
    if (node.ends.length > 2) { stat.branchNodeCount++; branchNodeCount++; continue; }
    if (node.ends.length !== 2 || node.ends[0]!.segmentId === node.ends[1]!.segmentId) continue;
    const bend = turnAngleDegrees(node.point, node.ends[0]!.other, node.ends[1]!.other);
    if (bend === undefined) continue;
    stat.eligibleJunctions++; eligibleJunctions++;
    // This is geometric evidence, not a manufacturing prohibition:
    // 45-degree elbows are normal; near-90 and near-180 bends deserve review.
    if (bend >= 150) { stat.reversalCount++; reversalCount++; }
    else if (bend >= 75 && bend <= 105) { stat.rightAngleCount++; rightAngleCount++; }
    else if (bend >= 20 && bend < 75) { stat.diagonalTurnCount++; diagonalTurnCount++; }
  }
  const topCandidates = [...summaries.values()]
    .filter(item => item.rightAngleCount > 0 || item.reversalCount > 0)
    .sort((a, b) => b.reversalCount - a.reversalCount || b.rightAngleCount - a.rightAngleCount || a.netName.localeCompare(b.netName))
    .slice(0, Math.max(1, Math.min(100, maxDetails)));
  return { methodology: 'Two straight same-net same-layer edges at the same endpoint; excludes via endpoints, branches and arcs. Visual-review candidates only.',
    eligibleJunctions, excludedViaJunctions, branchNodeCount, rightAngleCount, diagonalTurnCount, reversalCount, topCandidates };
}
