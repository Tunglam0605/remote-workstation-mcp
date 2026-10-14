/**
 * Deterministic multi-scenario READ-ONLY placement ranking.
 *
 * HPWL is a wiring-distance proxy, not routed copper length. Existing track
 * length and via counts are immutable baseline context, never simulated gains.
 * No scenario is manufacturing-approved without rerouting and official DRC.
 */
import {
  planConstrainedPlacement, connectorAccessEnvelope
} from './kicad-placement-constraints.js';
import type {
  PlacementPart, PlacementPoint, PlacementRect, PlacementConstraintOptions
} from './kicad-placement-constraints.js';

export interface PlacementNetTerminal {
  netName: string;
  reference: string;
  position: PlacementPoint;
}
export interface PlacementRouteBaseline {
  trackLengthMm: number;
  segmentCount: number;
  viaCount: number;
}
export interface PlacementRankingInput {
  parts: PlacementPart[];
  constraints: PlacementConstraintOptions;
  fixedReferences: ReadonlySet<string>;
  maxStepMm: number;
  gridMm: number;
  terminals: PlacementNetTerminal[];
  routeBaseline: PlacementRouteBaseline;
  // Prevent automatic recommendations whose geometric wiring proxy worsens.
  maxHpwlRegressionMm?: number;
}
type ScenarioCandidate = ReturnType<typeof planConstrainedPlacement>['candidates'][number];

function moved(rect: PlacementRect, dx: number, dy: number): PlacementRect {
  return { minX: rect.minX + dx, maxX: rect.maxX + dx, minY: rect.minY + dy, maxY: rect.maxY + dy };
}
function intersects(a: PlacementRect, b: PlacementRect, gap: number): boolean {
  return a.minX < b.maxX + gap - 1e-7 && a.maxX > b.minX - gap + 1e-7 &&
    a.minY < b.maxY + gap - 1e-7 && a.maxY > b.minY - gap + 1e-7;
}
function contained(a: PlacementRect, b: PlacementRect): boolean {
  return a.minX >= b.minX - 1e-7 && a.minY >= b.minY - 1e-7 &&
    a.maxX <= b.maxX + 1e-7 && a.maxY <= b.maxY + 1e-7;
}
function hpwl(points: PlacementPoint[]): number {
  if (points.length < 2) return 0;
  return Math.max(...points.map(p => p.x)) - Math.min(...points.map(p => p.x)) +
    Math.max(...points.map(p => p.y)) - Math.min(...points.map(p => p.y));
}
function r4(value: number): number { return Number(value.toFixed(4)); }

export function rankConstrainedPlacementScenarios(input: PlacementRankingInput) {
  const { parts, fixedReferences, constraints, terminals, routeBaseline } = input;
  const maxHpwlRegressionMm = input.maxHpwlRegressionMm ?? 0;
  if (!Number.isFinite(maxHpwlRegressionMm) || maxHpwlRegressionMm < 0 || maxHpwlRegressionMm > 1000) {
    throw new Error('maxHpwlRegressionMm must be between 0 and 1000.');
  }
  if (parts.length > 256 || terminals.length > 16384) throw new Error('Placement ranker source size exceeds bounded limits.');
  if (parts.length === 0) throw new Error('Placement ranker requires footprints.');
  for (const x of [routeBaseline.trackLengthMm, routeBaseline.segmentCount, routeBaseline.viaCount]) {
    if (!Number.isFinite(x) || x < 0) throw new Error('Invalid original-board routing metrics.');
  }
  // Use unchanged original-board geometry for all scenarios.
  const partMap = new Map(parts.map(p => [p.reference.toUpperCase(), p]));
  const grouped = new Map<string, PlacementNetTerminal[]>();
  for (const pin of terminals) {
    if (!partMap.has(pin.reference.toUpperCase())) throw new Error('Unknown placement net terminal reference ' + pin.reference);
    if (!Number.isFinite(pin.position.x) || !Number.isFinite(pin.position.y)) throw new Error('Invalid placement net terminal coordinates.');
    const refs = grouped.get(pin.netName) ?? [];
    refs.push(pin);
    grouped.set(pin.netName, refs);
  }
  // High-fanout power nets can dominate a naive HPWL proxy: cap at 24 pads.
  const usableNets = [...grouped.values()].filter(pins =>
    pins.length >= 2 && pins.length <= 24 &&
    new Set(pins.map(pin => pin.reference.toUpperCase())).size > 1);
  const baselineHpwl = usableNets.reduce((sum, pins) => sum + hpwl(pins.map(pin => pin.position)), 0);
  const gap = constraints.minCourtyardGapMm ?? 0;
  const connectorAccess = new Map((constraints.connectorAccess ?? []).map(item => [item.reference.toUpperCase(), item]));
  const fractions = [0.33, 0.66, 1] as const;

  const scenarios = fractions.map((fraction, index) => {
    const stepMm = input.maxStepMm * fraction;
    const plan = planConstrainedPlacement(parts, constraints, fixedReferences, stepMm, input.gridMm);
    const proposals = plan.candidates;
    const translations = new Map<string, PlacementPoint>();
    const blockers: string[] = [];
    const reviewHolds: string[] = [];
    let totalMovement = 0, alignmentBefore = 0, alignmentAfter = 0;
    for (const candidate of proposals) {
      const key = candidate.reference.toUpperCase();
      if (translations.has(key)) throw new Error('Duplicate move in a placement scenario: ' + key);
      const delta = {
        x: candidate.proposedPositionMm.x - candidate.currentPositionMm.x,
        y: candidate.proposedPositionMm.y - candidate.currentPositionMm.y
      };
      translations.set(key, delta);
      totalMovement += Math.hypot(delta.x, delta.y);
      alignmentBefore += Math.hypot(
        candidate.currentPositionMm.x - candidate.targetPositionMm.x,
        candidate.currentPositionMm.y - candidate.targetPositionMm.y);
      alignmentAfter += Math.hypot(
        candidate.proposedPositionMm.x - candidate.targetPositionMm.x,
        candidate.proposedPositionMm.y - candidate.targetPositionMm.y);
      blockers.push(...candidate.blockers.map(code => key + ':' + code));
      reviewHolds.push(...candidate.reviewNotes);
    }
    // Independently verify whole-scenario courtyard positions, including
    // simultaneous moves that single-candidate checking cannot detect.
    for (let a = 0; a < parts.length; a++) {
      const first = parts[a]!;
      const dx = translations.get(first.reference.toUpperCase());
      if (!dx) continue;
      if (!first.courtyard) {
        blockers.push(first.reference + ':missing-courtyard-geometry');
        continue;
      }
      const rect = moved(first.courtyard, dx.x, dx.y);
      const access = connectorAccess.get(first.reference.toUpperCase());
      const accessRect = access ? connectorAccessEnvelope(rect, access) : undefined;
      if (accessRect && !access!.allowOutsideBoard && constraints.boardBounds && !contained(accessRect, constraints.boardBounds)) {
        blockers.push(first.reference + ':connector-access-outside-board');
      }
      if (constraints.boardBounds && !contained(rect, constraints.boardBounds)) {
        blockers.push(first.reference + ':outside-board');
      }
      for (const keepout of constraints.keepouts ?? []) {
        if (intersects(rect, keepout.bounds, gap)) blockers.push(first.reference + ':keepout:' + keepout.id);
        if (accessRect && intersects(accessRect, keepout.bounds, gap)) blockers.push(first.reference + ':connector-access-keepout:' + keepout.id);
      }
      for (let b = 0; b < parts.length; b++) {
        if (a === b) continue;
        const second = parts[b]!;
        const offset = translations.get(second.reference.toUpperCase()) ?? { x: 0, y: 0 };
        if (!second.courtyard) {
          reviewHolds.push('Missing courtyard for ' + second.reference + '; manual clearance review needed.');
          continue;
        }
        const secondRect = moved(second.courtyard, offset.x, offset.y);
        if (intersects(rect, secondRect, gap)) {
          blockers.push('courtyard-overlap:' + first.reference + ':' + second.reference);
        }
        if (accessRect && intersects(accessRect, secondRect, gap)) {
          blockers.push('connector-access-overlap:' + first.reference + ':' + second.reference);
        }
        const secondAccess = connectorAccess.get(second.reference.toUpperCase());
        if (secondAccess && intersects(rect, connectorAccessEnvelope(secondRect, secondAccess), gap)) {
          blockers.push('blocks-connector-access:' + second.reference + ':' + first.reference);
        }
      }
    }

    let scenarioHpwl = 0;
    for (const pins of usableNets) {
      const positions = pins.map(pin => {
        const translation = translations.get(pin.reference.toUpperCase()) ?? { x: 0, y: 0 };
        return { x: pin.position.x + translation.x, y: pin.position.y + translation.y };
      });
      scenarioHpwl += hpwl(positions);
    }
    const estimatedHpwlGain = baselineHpwl - scenarioHpwl;
    const alignmentGain = alignmentBefore - alignmentAfter;
    // Unverified routing makes movement costly. A good score still cannot
    // override any geometric block or missing manufacturing evidence.
    const score = 4 * alignmentGain + estimatedHpwlGain - 0.25 * totalMovement;
    const uniqueBlockers = [...new Set(blockers)].sort();
    const hpwlRegression = scenarioHpwl - baselineHpwl > maxHpwlRegressionMm + 1e-6;
    if (hpwlRegression) reviewHolds.push('HPWL wiring proxy increased beyond permitted regression; do not auto-recommend.');
    const uniqueHolds = [...new Set(reviewHolds)].sort();
    return {
      id: 'scenario-' + (index + 1),
      stepFraction: fraction,
      stepMm: r4(stepMm),
      status: uniqueBlockers.length ? 'blocked' as const : hpwlRegression ? 'tradeoff-review' as const : 'review-only' as const,
      score: r4(score),
      sourceOnly: true as const,
      manufacturingApproved: false as const,
      rerouteAndOfficialDrcRequired: true as const,
      metrics: {
        alignmentDistanceBeforeMm: r4(alignmentBefore),
        alignmentDistanceAfterMm: r4(alignmentAfter),
        hpwlBeforeMm: r4(baselineHpwl),
        hpwlProxyAfterMm: r4(scenarioHpwl),
        hpwlProxyGainMm: r4(estimatedHpwlGain),
        totalMovementMm: r4(totalMovement),
        // Immutable original PCB, not predicted routed copper after changes.
        originalRoutedTrackLengthMm: r4(routeBaseline.trackLengthMm),
        originalViaCount: routeBaseline.viaCount,
        originalSegmentCount: routeBaseline.segmentCount,
        boardAreaDeltaMm2: 0,
        newlyRoutedTrackLengthKnown: false
      },
      proposalCount: proposals.length,
      movedReferences: [...translations.keys()].sort(),
      blockers: uniqueBlockers,
      reviewHolds: uniqueHolds,
      proposals: proposals.map((p: ScenarioCandidate) => ({
        reference: p.reference, groupId: p.groupId, status: p.status,
        from: p.currentPositionMm, to: p.proposedPositionMm, target: p.targetPositionMm,
        blockers: p.blockers
      }))
    };
  });
  const ranked = scenarios.filter(item => item.status === 'review-only' && item.proposalCount > 0)
    .sort((a, b) => b.score - a.score || a.stepMm - b.stepMm || a.id.localeCompare(b.id));
  const recommended = ranked[0] && ranked[0].score > 0 ? ranked[0].id : null;
  return {
    method: 'deterministic-bounded-multi-scenario-score' as const,
    hypothesisCount: scenarios.length,
    recommendedScenarioId: recommended,
    evidenceLimits: {
      sourceOnly: true,
      collisionApproximation: 'courtyard-AABB-only',
      boardAreaFixed: true,
      trackLengthAndViasAreOriginalBoardBaselineOnly: true,
      noCopperOrKiCadDrcOnHypotheses: true,
      physicalClearanceNotApproved: true
    },
    weights: { alignmentGain: 4, hpwlGain: 1, movementCost: 0.25 },
    maxHpwlRegressionMm,
    rankedScenarios: [...scenarios].sort((a, b) => {
      if (a.status !== b.status) {
        const order = { 'review-only': 0, 'tradeoff-review': 1, blocked: 2 };
        return order[a.status] - order[b.status];
      }
      return b.score - a.score || a.stepMm - b.stepMm;
    })
  };
}
