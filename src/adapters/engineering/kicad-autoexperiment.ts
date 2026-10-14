/**
 * PCB copy-only design experiments.
 *
 * This is intentionally NOT a manufacturing autorouter. It applies vetted
 * placement suggestions to isolated copies, routes the copies with the
 * existing bounded planner and accepts only real KiCad DRC non-regression
 * (and strictly improved connectivity). Originals are never written.
 */
import { patchKicadDocument } from './kicad-edit.js';
import { applyKicadRouteBatch } from './kicad-route-batch.js';
import { planKicadRoutes, type KicadRoutePlanOptions } from './kicad-route-plan.js';

export interface KicadExperimentDrc {
  violations: number;
  unconnected: number;
  schematicParity: number;
  errors: number;
}

export interface KicadExperimentScenario {
  id: string;
  status: 'review-only' | 'tradeoff-review' | 'blocked';
  score: number;
  routing?: KicadRoutePlanOptions;
  proposals: Array<{
    reference: string;
    from: { x: number; y: number };
    to: { x: number; y: number };
  }>;
}
export interface KicadExperimentRequest {
  scenarios: KicadExperimentScenario[];
  routing: KicadRoutePlanOptions;
  baseline: KicadExperimentDrc;
  // The caller validates via the official KiCad CLI on its own isolated board copy.
  validate: (id: string, boardSource: string) => Promise<KicadExperimentDrc>;
}
function validCounts(x: KicadExperimentDrc): void {
  for (const key of ['violations','unconnected','schematicParity','errors'] as const) {
    if (!Number.isSafeInteger(x[key]) || x[key] < 0) throw new Error('Invalid official KiCad DRC count: ' + key);
  }
}
function evaluate(previous: KicadExperimentDrc, next: KicadExperimentDrc) {
  const reasons: string[] = [];
  if (next.violations > previous.violations) reasons.push('drc-violations-regression');
  if (next.unconnected > previous.unconnected) reasons.push('unconnected-regression');
  if (next.schematicParity > previous.schematicParity) reasons.push('schematic-parity-regression');
  if (next.errors > previous.errors) reasons.push('drc-errors-regression');
  if (next.unconnected >= previous.unconnected) reasons.push('no-official-connectivity-improvement');
  return { accepted: reasons.length === 0, reasons };
}

export async function runKicadCopyExperiments(originalSource: string, request: KicadExperimentRequest) {
  if (!originalSource || Buffer.byteLength(originalSource, 'utf8') > 32 * 1024 * 1024) {
    throw new Error('KiCad autoexperiment source must be nonempty and at most 32 MiB.');
  }
  if (request.scenarios.length < 1 || request.scenarios.length > 3) {
    throw new Error('KiCad autoexperiment requires 1..3 bounded scenarios.');
  }
  validCounts(request.baseline);
  const seen = new Set<string>();
  const candidates: Array<{
    id: string;
    status: 'blocked' | 'tradeoff-review' | 'candidate-rejected' | 'candidate-accepted' | 'failed-review';
    reasons: string[];
    proposalCount: number;
    operationCount: number;
    addedStraightTrackLengthMm?: number;
    addedViaCount?: number;
    originalDrc: KicadExperimentDrc;
    candidateDrc?: KicadExperimentDrc;
    scenarioScore: number;
    routeComplete?: boolean;
    routingSkippedCount?: number;
    source?: string;
  }> = [];
  for (const scenario of request.scenarios) {
    if (!/^[-A-Za-z0-9_]{1,64}$/.test(scenario.id) || seen.has(scenario.id)) {
      throw new Error('Invalid or duplicate KiCad autoexperiment scenario id.');
    }
    seen.add(scenario.id);
    if (scenario.proposals.length > 32 || !Number.isFinite(scenario.score)) {
      throw new Error('Invalid bounded KiCad autoexperiment proposals.');
    }
    const base = {
      id: scenario.id,
      proposalCount: scenario.proposals.length,
      scenarioScore: scenario.score,
      operationCount: 0,
      originalDrc: request.baseline
    };
    if (scenario.status !== 'review-only') {
      candidates.push({ ...base, status: scenario.status, reasons: ['scenario-not-approved-for-automated-experiment'] });
      continue;
    }
    try {
      let board = originalSource;
      if (scenario.proposals.length) {
        const moved = new Set<string>();
        const edits = scenario.proposals.map(p => {
          if (moved.has(p.reference.toUpperCase())) throw new Error('Duplicate footprint move in one scenario.');
          moved.add(p.reference.toUpperCase());
          for (const coordinate of [p.from.x,p.from.y,p.to.x,p.to.y]) {
            if (!Number.isFinite(coordinate)) throw new Error('Invalid footprint move coordinates.');
          }
          return { kind: 'pcb_footprint_move' as const, reference: p.reference, x: p.to.x, y: p.to.y };
        });
        // The edit engine requires an exact footprint reference and preserves
        // all unrelated KiCad source blocks.
        board = patchKicadDocument(originalSource, edits, '.kicad_pcb').text;
      }
      const routing = { ...request.routing, ...scenario.routing };
      const routePlan = planKicadRoutes(board, { ...routing, maxOperations: Math.min(64, routing.maxOperations ?? 32) });
      const applied = routePlan.operations.length ? applyKicadRouteBatch(board, routePlan.operations) : undefined;
      if (applied) board = applied.source;
      const candidateDrc = await request.validate(scenario.id, board);
      validCounts(candidateDrc);
      const gate = evaluate(request.baseline, candidateDrc);
      candidates.push({
        ...base,
        status: gate.accepted ? 'candidate-accepted' : 'candidate-rejected',
        reasons: gate.reasons,
        operationCount: routePlan.operationCount,
        addedStraightTrackLengthMm: applied?.summary.totalStraightLengthMm ?? 0,
        addedViaCount: applied?.summary.vias ?? 0,
        candidateDrc,
        routeComplete: routePlan.complete,
        routingSkippedCount: routePlan.nets.skippedCount,
        source: board
      });
    } catch (error) {
      candidates.push({
        ...base,
        status: 'failed-review',
        reasons: ['experiment-failed:' + (error instanceof Error ? error.message.slice(0, 320) : 'unknown')]
      });
    }
  }
  const accepted = candidates.filter(item => item.status === 'candidate-accepted')
    .sort((a,b) => a.candidateDrc!.unconnected - b.candidateDrc!.unconnected ||
      a.candidateDrc!.violations - b.candidateDrc!.violations ||
      (a.addedViaCount ?? 0) - (b.addedViaCount ?? 0) ||
      (a.addedStraightTrackLengthMm ?? 0) - (b.addedStraightTrackLengthMm ?? 0) ||
      b.scenarioScore - a.scenarioScore || a.id.localeCompare(b.id));
  return {
    schemaVersion: 1,
    method: 'isolated-official-drc-gated-routing' as const,
    originalPreserved: true as const,
    manufacturingApproved: false as const,
    originalDrc: request.baseline,
    selectedCandidateId: accepted[0]?.id ?? null,
    candidates,
    limitations: [
      'All accepted candidates remain in separate copy-only experiment directories.',
      'The KiCad DRC checks count regressions, not functional/thermal/mechanical manufacturability.',
      'Existing copper is never ripped up automatically; moving a connected footprint can leave stale tracks and be rejected.',
      'Differential pairs, impedance, thermal, eFuse and DC/DC return path need independent review.'
    ]
  };
}
